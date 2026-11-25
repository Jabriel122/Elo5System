#include <WiFi.h>
#include <PubSubClient.h>
#include <SPI.h>
#include <MFRC522.h>

// ---------- Rede e MQTT ----------
// No Wokwi a rede é sempre "Wokwi-GUEST" (sem senha, canal 6).
// No ESP32 real, troque pelo nome e senha do seu WiFi.
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";

const char* MQTT_HOST  = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
// Precisa ser IGUAL ao TOPIC_SENSORS do server.js
const char* MQTT_TOPIC = "elo5-system/sensores/dados";

// ---------- Pinos ----------
const int PIN_TRIG         = 5;
const int PIN_ECHO         = 18;
const int PIN_SENSOR_PORTA = 4;
const int PIN_PIR          = 19;

// Leitor NFC/RFID (RC522): SPI remapeado para pinos que não conflitam com os acima
const int PIN_RFID_SCK  = 25;
const int PIN_RFID_MISO = 26;
const int PIN_RFID_MOSI = 27;
const int PIN_RFID_SS   = 32;  // pino "SDA" do módulo
const int PIN_RFID_RST  = 33;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);

unsigned long ultimoEnvio = 0;
unsigned long ultimaLeituraCartao = 0;
bool ultimoPorta = false;
bool ultimoPir   = false;

void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("[WiFi] Conectando");
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println(" OK");
}

void conectarMqtt() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Conectando...");
    String id = "elo5-esp32-" + String((uint32_t)esp_random(), HEX);
    if (mqtt.connect(id.c_str())) {
      Serial.println(" OK");
    } else {
      Serial.printf(" falhou (rc=%d), tentando de novo em 2s\n", mqtt.state());
      delay(2000);
    }
  }
}

// Retorna a distância em cm, ou -1 se estiver fora de alcance
float lerDistanciaCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  uint32_t duracao = pulseIn(PIN_ECHO, HIGH, 30000);
  if (duracao == 0) return -1;

  float cm = (duracao * 0.0343f) / 2.0f;
  return (cm > 400.0f) ? -1 : cm;
}

// Retorna true e preenche 'uid' (ex: "AA:BB:CC:DD") quando um cartão novo é aproximado.
// 'uid' precisa ter pelo menos 24 bytes (cabe UID de até 7 bytes).
bool lerCartao(char* uid, size_t tamanho) {
  if (millis() - ultimaLeituraCartao < 1500) return false;  // evita leituras repetidas
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return false;

  uid[0] = '\0';
  for (byte i = 0; i < rfid.uid.size; i++) {
    char parte[4];
    snprintf(parte, sizeof(parte), i == 0 ? "%02X" : ":%02X", rfid.uid.uidByte[i]);
    strncat(uid, parte, tamanho - strlen(uid) - 1);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  ultimaLeituraCartao = millis();
  return true;
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_SENSOR_PORTA, INPUT_PULLUP);
  pinMode(PIN_PIR, INPUT);

  // Leitor NFC/RFID
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  rfid.PCD_Init();
  byte versao = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("[NFC] Leitor RC522 versao 0x%02X%s\n", versao,
                (versao == 0x00 || versao == 0xFF) ? " (NAO DETECTADO - confira a fiacao)" : "");

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
}

void loop() {
  conectarWiFi();
  conectarMqtt();
  mqtt.loop();

  // --- Leituras ---
  bool portaAberta = (digitalRead(PIN_SENSOR_PORTA) == HIGH);
  bool pirMovimento = (digitalRead(PIN_PIR) == HIGH);
  float distanciaCm = lerDistanciaCm();

  char cartaoUid[24];
  bool novoCartao = lerCartao(cartaoUid, sizeof(cartaoUid));
  if (novoCartao) Serial.printf("[NFC] Cartao lido: %s\n", cartaoUid);

  // --- Monitor Serial ---
  Serial.print("[PORTA] ");
  Serial.print(portaAberta ? "ALERTA: Porta ABERTA! | " : "Status: Fechada       | ");
  Serial.print("[PIR] ");
  Serial.print(pirMovimento ? "Movimento | " : "Sem movimento | ");
  Serial.print("[DISTANCIA] ");
  if (distanciaCm < 0) Serial.println("Fora de alcance");
  else Serial.printf("%.1f cm\n", distanciaCm);

  // --- Envio: a cada 1s, ou na hora se a porta/PIR mudar ou um cartão for lido ---
  bool mudou = (portaAberta != ultimoPorta) || (pirMovimento != ultimoPir);
  if (novoCartao || mudou || millis() - ultimoEnvio >= 1000) {
    char distanciaJson[16];
    if (distanciaCm < 0) strcpy(distanciaJson, "null");
    else snprintf(distanciaJson, sizeof(distanciaJson), "%.1f", distanciaCm);

    // O campo cartao_uid só vai na mensagem em que o cartão foi lido
    char cartaoJson[48] = "";
    if (novoCartao) snprintf(cartaoJson, sizeof(cartaoJson), ",\"cartao_uid\":\"%s\"", cartaoUid);

    char payload[192];
    snprintf(payload, sizeof(payload),
             "{\"porta_aberta\":%s,\"distancia_cm\":%s,\"pir_movimento\":%s%s}",
             portaAberta ? "true" : "false",
             distanciaJson,
             pirMovimento ? "true" : "false",
             cartaoJson);

    bool ok = mqtt.publish(MQTT_TOPIC, payload);
    Serial.printf("[MQTT] %s -> %s\n", ok ? "enviado" : "FALHOU", payload);

    ultimoEnvio = millis();
    ultimoPorta = portaAberta;
    ultimoPir   = pirMovimento;
  }

  delay(100);
}
