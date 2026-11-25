// ESP DO NFC - leitor de cartão + botão de saída do rack.
// Só publica eventos no MQTT; quem decide acesso permitido/negado é o servidor (server.js).

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
// Precisa ser IGUAL ao TOPIC_NFC do server.js
const char* MQTT_TOPIC = "elo5-system/nfc/eventos";

// ---------- Pinos ----------
// Leitor RC522 nos pinos SPI padrão do ESP32 (os mesmos do exemplo do Wokwi)
const int PIN_RFID_SS  = 5;    // pino "SDA" do módulo
const int PIN_RFID_RST = 21;
// SCK = 18, MISO = 19, MOSI = 23 (padrão, não precisa configurar)

const int PIN_BOTAO_SAIDA = 4;  // botão "para sair do rack": liga o pino ao GND

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);

unsigned long ultimaLeituraCartao = 0;

// O botão usa interrupção para não perder cliques rápidos
volatile bool botaoSaidaFlag = false;
volatile unsigned long ultimoBotaoMs = 0;

void IRAM_ATTR aoApertarBotaoSaida() {
  unsigned long agora = millis();
  if (agora - ultimoBotaoMs > 300) {  // debounce
    botaoSaidaFlag = true;
    ultimoBotaoMs = agora;
  }
}

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
    String id = "elo5-nfc-" + String((uint32_t)esp_random(), HEX);
    if (mqtt.connect(id.c_str())) {
      Serial.println(" OK");
    } else {
      Serial.printf(" falhou (rc=%d), tentando de novo em 2s\n", mqtt.state());
      delay(2000);
    }
  }
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

  pinMode(PIN_BOTAO_SAIDA, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_BOTAO_SAIDA), aoApertarBotaoSaida, FALLING);

  SPI.begin();
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

  char cartaoUid[24];
  bool novoCartao = lerCartao(cartaoUid, sizeof(cartaoUid));

  bool botaoSaida = botaoSaidaFlag;
  botaoSaidaFlag = false;

  // Só publica quando acontece alguma coisa (cartão aproximado e/ou botão apertado)
  if (novoCartao || botaoSaida) {
    if (novoCartao) Serial.printf("[NFC] Cartao lido: %s\n", cartaoUid);
    if (botaoSaida) Serial.println("[BOTAO] Saida do rack solicitada");

    char cartaoJson[48] = "";
    if (novoCartao) snprintf(cartaoJson, sizeof(cartaoJson), "\"cartao_uid\":\"%s\"", cartaoUid);

    char payload[96];
    snprintf(payload, sizeof(payload), "{%s%s%s}",
             cartaoJson,
             (novoCartao && botaoSaida) ? "," : "",
             botaoSaida ? "\"botao_saida\":true" : "");

    bool ok = mqtt.publish(MQTT_TOPIC, payload);
    Serial.printf("[MQTT] %s -> %s\n", ok ? "enviado" : "FALHOU", payload);
  }

  delay(50);
}
