const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Servir o arquivo frontend index.html na raiz
app.use(express.static(path.join(__dirname, 'public')));

const BROKER_URL = 'mqtt://broker.hivemq.com:1883';
const TOPIC_SENSORS = 'elo5-system/sensores/dados';

let estadoAtual = {
  porta_aberta: false,
  distancia_cm: null,
  pir_movimento: false,
  atualizado_em: null
};

// Histórico em memória dos últimos 50 logs
let historicoLogs = [];

const mqttClient = mqtt.connect(BROKER_URL);

mqttClient.on('connect', () => {
  console.log('[API] Conectada ao Broker MQTT!');
  mqttClient.subscribe(TOPIC_SENSORS);
});

mqttClient.on('message', (topic, payload) => {
  try {
    const dados = JSON.parse(payload.toString());
    const agora = new Date().toLocaleString('pt-BR');

    estadoAtual = {
      ...dados,
      atualizado_em: agora
    };

    // Gera decisões de alerta baseadas nos sensores
    let decisao = "NORMAL";
    let classeAlerta = "ok";

    if (dados.porta_aberta) {
      decisao = "ALERTA: PORTA ABERTA";
      classeAlerta = "alerta";
    } else if (dados.pir_movimento) {
      decisao = "MOVIMENTO DETECTADO";
      classeAlerta = "atencao";
    } else if (dados.distancia_cm !== null && dados.distancia_cm < 15.0) {
      decisao = "INTERVENÇÃO PRÓXIMA";
      classeAlerta = "atencao";
    }

    // Cria registro de log
    const novoLog = {
      id: Date.now(),
      hora: agora,
      porta: dados.porta_aberta ? "ABERTA" : "FECHADA",
      pir: dados.pir_movimento ? "COM MOVIMENTO" : "SEM MOVIMENTO",
      distancia: dados.distancia_cm !== null ? `${dados.distancia_cm} cm` : "FORA DE ALCANCE",
      decisao: decisao,
      statusClass: classeAlerta
    };

    const ultimo = historicoLogs[0];
    const repetido = ultimo &&
      ultimo.porta === novoLog.porta &&
      ultimo.pir === novoLog.pir &&
      ultimo.decisao === novoLog.decisao;

    if (!dados.porta_aberta && repetido) return; // porta fechada e nada mudou: não repete

    // Adiciona ao topo e limita a 50 itens
    historicoLogs.unshift(novoLog);
    if (historicoLogs.length > 50) historicoLogs.pop();

    console.log('[API] Log registrado:', novoLog);
  } catch (error) {
    console.error('[API] Erro no JSON:', error.message);
  }
});

// Endpoint dos logs
app.get('/api/sensores/logs', (req, res) => {
  res.json({
    statusAtual: estadoAtual,
    logs: historicoLogs
  });
});

app.listen(3000, () => {
  console.log('[API] ELO5 System rodando em http://localhost:3000');
});