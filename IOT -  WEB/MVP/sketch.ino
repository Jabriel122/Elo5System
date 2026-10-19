#include <WiFi.h>
#include <PubSubClient.h>

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

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long ultimoEnvio = 0;
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

void setup() {
  Serial.begin(115200);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_SENSOR_PORTA, INPUT_PULLUP);
  pinMode(PIN_PIR, INPUT);

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

  // --- Monitor Serial ---
  Serial.print("[PORTA] ");
  Serial.print(portaAberta ? "ALERTA: Porta ABERTA! | " : "Status: Fechada       | ");
  Serial.print("[PIR] ");
  Serial.print(pirMovimento ? "Movimento | " : "Sem movimento | ");
  Serial.print("[DISTANCIA] ");
  if (distanciaCm < 0) Serial.println("Fora de alcance");
  else Serial.printf("%.1f cm\n", distanciaCm);

  // --- Envio: a cada 1s, ou na hora se a porta/PIR mudar de estado ---
  bool mudou = (portaAberta != ultimoPorta) || (pirMovimento != ultimoPir);
  if (mudou || millis() - ultimoEnvio >= 1000) {
    char payload[128];
    if (distanciaCm < 0) {
      snprintf(payload, sizeof(payload),
               "{\"porta_aberta\":%s,\"distancia_cm\":null,\"pir_movimento\":%s}",
               portaAberta ? "true" : "false",
               pirMovimento ? "true" : "false");
    } else {
      snprintf(payload, sizeof(payload),
               "{\"porta_aberta\":%s,\"distancia_cm\":%.1f,\"pir_movimento\":%s}",
               portaAberta ? "true" : "false",
               distanciaCm,
               pirMovimento ? "true" : "false");
    }

    bool ok = mqtt.publish(MQTT_TOPIC, payload);
    Serial.printf("[MQTT] %s -> %s\n", ok ? "enviado" : "FALHOU", payload);

    ultimoEnvio = millis();
    ultimoPorta = portaAberta;
    ultimoPir   = pirMovimento;
  }

  delay(100);
}
