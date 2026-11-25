#include <WiFi.h>
#include <PubSubClient.h>
#include "DHTesp.h"   // biblioteca "DHT sensor library for ESPx"

// ---------- Rede e MQTT ----------
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
const int PIN_DHT          = 21;  // DHT22: temperatura e umidade da sala

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
DHTesp dht;

unsigned long ultimoEnvio = 0;
bool ultimoPorta = false;
bool ultimoPir   = false;

// Clima da sala (NAN = sem leitura)
float temperaturaC = NAN;
float umidadePct   = NAN;
unsigned long ultimaLeituraClima = 0;
bool climaJaLido = false;

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

// O DHT22 só aceita uma leitura a cada ~2s, então as leituras ficam guardadas entre uma e outra
void atualizarClima() {
  if (climaJaLido && millis() - ultimaLeituraClima < 2000) return;
  ultimaLeituraClima = millis();
  climaJaLido = true;

  TempAndHumidity leitura = dht.getTempAndHumidity();
  if (dht.getStatus() != DHTesp::ERROR_NONE) {
    temperaturaC = NAN;
    umidadePct = NAN;
    Serial.printf("[DHT] Erro na leitura: %s\n", dht.getStatusString());
    return;
  }

  temperaturaC = leitura.temperature;
  umidadePct = leitura.humidity;
}

// Escreve um número no JSON: "24.5" ou "null" quando não há leitura
void numeroJson(char* destino, size_t tamanho, float valor) {
  if (isnan(valor)) snprintf(destino, tamanho, "null");
  else snprintf(destino, tamanho, "%.1f", valor);
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_SENSOR_PORTA, INPUT_PULLUP);
  pinMode(PIN_PIR, INPUT);

  dht.setup(PIN_DHT, DHTesp::DHT22);

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
  atualizarClima();

  // --- Monitor Serial ---
  Serial.print("[PORTA] ");
  Serial.print(portaAberta ? "ALERTA: Porta ABERTA! | " : "Status: Fechada       | ");
  Serial.print("[PIR] ");
  Serial.print(pirMovimento ? "Movimento | " : "Sem movimento | ");
  Serial.print("[DISTANCIA] ");
  if (distanciaCm < 0) Serial.print("Fora de alcance | ");
  else Serial.printf("%.1f cm | ", distanciaCm);
  Serial.print("[CLIMA] ");
  if (isnan(temperaturaC)) Serial.println("sem leitura");
  else Serial.printf("%.1f C / %.0f %%\n", temperaturaC, umidadePct);

  // --- Envio: a cada 1s, ou na hora se a porta/PIR mudar de estado ---
  bool mudou = (portaAberta != ultimoPorta) || (pirMovimento != ultimoPir);
  if (mudou || millis() - ultimoEnvio >= 1000) {
    char distanciaJson[16], temperaturaJson[16], umidadeJson[16];
    numeroJson(distanciaJson, sizeof(distanciaJson), distanciaCm < 0 ? NAN : distanciaCm);
    numeroJson(temperaturaJson, sizeof(temperaturaJson), temperaturaC);
    numeroJson(umidadeJson, sizeof(umidadeJson), umidadePct);

    char payload[192];
    snprintf(payload, sizeof(payload),
             "{\"porta_aberta\":%s,\"distancia_cm\":%s,\"pir_movimento\":%s,\"temperatura_c\":%s,\"umidade_pct\":%s}",
             portaAberta ? "true" : "false",
             distanciaJson,
             pirMovimento ? "true" : "false",
             temperaturaJson,
             umidadeJson);

    bool ok = mqtt.publish(MQTT_TOPIC, payload);
    Serial.printf("[MQTT] %s -> %s\n", ok ? "enviado" : "FALHOU", payload);

    ultimoEnvio = millis();
    ultimoPorta = portaAberta;
    ultimoPir   = pirMovimento;
  }

  delay(100);
}