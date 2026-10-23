const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Servir o arquivo frontend index.html na raiz
app.use(express.static(path.join(__dirname, 'public')));

const BROKER_URL    = 'mqtt://broker.hivemq.com:1883';
const TOPIC_SENSORS = 'elo5-system/sensores/dados';

// Cartões autorizados (UID -> nome). Qualquer outro UID é registrado como NEGADO.
// Os UIDs abaixo são os dos cartões do Wokwi (azul e verde).
const CARTOES_AUTORIZADOS = {
  '01:02:03:04': 'Cartão Azul',
  '11:22:33:44': 'Cartão Verde'
};

// 4 a 10 bytes em hexadecimal separados por ":" (o UID vem de fora, então é validado)
const UID_VALIDO = /^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$/;

let estadoAtual = {
  porta_aberta: false,
  distancia_cm: null,
  pir_movimento: false,
  atualizado_em: null
};

// Histórico em memória dos últimos 50 logs
let historicoLogs = [];

// Resumo do último estado gravado (porta + PIR + decisão dos sensores), usado para não repetir
let ultimaAssinatura = null;

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

    // Leitura de cartão NFC/RFID (só vem na mensagem em que o cartão foi aproximado)
    const cartaoUid = typeof dados.cartao_uid === 'string' ? dados.cartao_uid.toUpperCase() : null;
    const cartaoValido = cartaoUid !== null && UID_VALIDO.test(cartaoUid);

    // Assinatura calculada ANTES de o cartão alterar a decisão exibida
    const assinatura = `${dados.porta_aberta}|${dados.pir_movimento}|${decisao}`;

    let decisaoExibida = decisao;
    let classeExibida = classeAlerta;
    let cartaoExibido = "—";

    if (cartaoValido) {
      const nome = CARTOES_AUTORIZADOS[cartaoUid];
      if (nome) {
        decisaoExibida = `ACESSO AUTORIZADO: ${nome}`;
        classeExibida = "ok";
        cartaoExibido = `${nome} (${cartaoUid})`;
      } else {
        decisaoExibida = `ACESSO NEGADO: ${cartaoUid}`;
        classeExibida = "alerta";
        cartaoExibido = cartaoUid;
      }
    }

    // Cria registro de log
    const novoLog = {
      id: Date.now(),
      hora: agora,
      porta: dados.porta_aberta ? "ABERTA" : "FECHADA",
      pir: dados.pir_movimento ? "COM MOVIMENTO" : "SEM MOVIMENTO",
      distancia: dados.distancia_cm !== null ? `${dados.distancia_cm} cm` : "FORA DE ALCANCE",
      cartao: cartaoExibido,
      decisao: decisaoExibida,
      statusClass: classeExibida
    };

    // Porta fechada, sem cartão e nada mudou desde o último log: não repete na tabela
    if (!cartaoValido && !dados.porta_aberta && assinatura === ultimaAssinatura) return;
    ultimaAssinatura = assinatura;

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