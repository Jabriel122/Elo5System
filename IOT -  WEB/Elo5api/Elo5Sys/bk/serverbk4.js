const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Servir o arquivo frontend index.html na raiz
app.use(express.static(path.join(__dirname, 'public')));

// BROKER_URL só é usada para testes locais; normalmente vale o HiveMQ
const BROKER_URL    = process.env.BROKER_URL || 'mqtt://broker.hivemq.com:1883';
const TOPIC_SENSORS = 'elo5-system/sensores/dados';

// =====================================================================
// FAIXAS DE CLIMA PARA SERVIDOR (ajuste aqui se precisar)
//   IDEAL   : dentro da faixa ideal
//   ATENÇÃO : fora da faixa ideal, mas ainda dentro do limite aceitável
//   CRÍTICO : fora do limite aceitável
// Temperatura: recomendada 18–27 °C e aceitável 15–32 °C (ASHRAE, classe A1).
// Umidade: faixa prática de 40–60 % UR, aceitável 20–80 % UR. (A ASHRAE
// define a umidade por ponto de orvalho, então esta é uma simplificação.)
// =====================================================================
const FAIXAS_CLIMA = {
  temp: { idealMin: 18, idealMax: 27, limiteMin: 15, limiteMax: 32 },  // °C
  umid: { idealMin: 40, idealMax: 60, limiteMin: 20, limiteMax: 80 }   // % UR
};

const RANK_NIVEL = { IDEAL: 0, ATENCAO: 1, CRITICO: 2 };

function classificarClima(temp, umid) {
  if (temp === null || umid === null) {
    return { nivel: 'SEM_LEITURA', motivos: ['SENSOR SEM LEITURA'] };
  }

  let nivel = 'IDEAL';
  const motivos = [];

  const avaliar = (valor, faixa, nome) => {
    let nivelItem = 'IDEAL';
    if (valor < faixa.limiteMin)      { nivelItem = 'CRITICO'; motivos.push(`${nome} MUITO BAIXA`); }
    else if (valor > faixa.limiteMax) { nivelItem = 'CRITICO'; motivos.push(`${nome} MUITO ALTA`); }
    else if (valor < faixa.idealMin)  { nivelItem = 'ATENCAO'; motivos.push(`${nome} BAIXA`); }
    else if (valor > faixa.idealMax)  { nivelItem = 'ATENCAO'; motivos.push(`${nome} ALTA`); }
    if (RANK_NIVEL[nivelItem] > RANK_NIVEL[nivel]) nivel = nivelItem;
  };

  avaliar(temp, FAIXAS_CLIMA.temp, 'TEMPERATURA');
  avaliar(umid, FAIXAS_CLIMA.umid, 'UMIDADE');

  return { nivel, motivos };
}

// Aceita só números plausíveis (o broker é público: qualquer um pode publicar)
function numeroEntre(valor, min, max) {
  return Number.isFinite(valor) && valor >= min && valor <= max ? valor : null;
}

// =====================================================================
// LÓGICA DOS SENSORES - segue o fluxo do arquivo Elo5Log.drawio (sem NFC)
//   PIR: sem movimento -> registra uma vez e não repete
//        com movimento -> vale a porta:
//          porta aberta  -> registra "aberto" + distância e REPETE até fechar
//          porta fechada -> registra "fechado" + "sem aproximação" uma vez só
// =====================================================================
let pirEstado = null;     // 'SEM' | 'COM' (último estado já registrado)
let portaEstado = null;   // 'FECHADA' | 'ABERTA' (último estado já registrado)
let climaChave = null;    // último nível + motivos de clima já registrados
let climaPendente = null; // mudança de clima ainda não confirmada
let climaContagem = 0;    // quantas leituras seguidas confirmaram a mudança
const LEITURAS_PARA_CONFIRMAR = 3;

let estadoAtual = {
  porta_aberta: false,
  distancia_cm: null,
  pir_movimento: false,
  temperatura_c: null,
  umidade_pct: null,
  atualizado_em: null
};

let climaAtual = { temperatura: null, umidade: null, nivel: null, motivos: [] };
let textoClimaAtual = '—';

// Últimas leituras de clima, para o gráfico de tendência (~5 min a 1 leitura/s)
const MAX_HISTORICO_CLIMA = 300;
let historicoClima = [];

// Histórico em memória dos últimos 50 logs
let historicoLogs = [];
let seqLog = 0;

function registrarLog({ porta = '—', pir = '—', distancia = '—', evento, classe }) {
  const novoLog = {
    id: ++seqLog,
    hora: new Date().toLocaleString('pt-BR'),
    porta,
    pir,
    distancia,
    clima: textoClimaAtual,
    decisao: evento,
    statusClass: classe
  };

  historicoLogs.unshift(novoLog);
  if (historicoLogs.length > 50) historicoLogs.pop();

  console.log('[API] Log registrado:', novoLog);
}

function processarLeitura(d) {
  const portaAberta = d.porta_aberta === true;
  const movimento   = d.pir_movimento === true;
  const textoDistancia = Number.isFinite(d.distancia_cm) ? `${d.distancia_cm} cm` : 'FORA DE ALCANCE';

  // ---------- Clima da sala ----------
  const temp = numeroEntre(d.temperatura_c, -40, 125);
  const umid = numeroEntre(d.umidade_pct, 0, 100);
  const clima = classificarClima(temp, umid);

  textoClimaAtual = (temp !== null && umid !== null) ? `${temp.toFixed(1)} °C / ${Math.round(umid)} %` : '—';
  climaAtual = { temperatura: temp, umidade: umid, nivel: clima.nivel, motivos: clima.motivos };

  if (temp !== null && umid !== null) {
    historicoClima.push({ t: Date.now(), temp, umid });
    if (historicoClima.length > MAX_HISTORICO_CLIMA) historicoClima.shift();
  }

  // Só registra quando o nível ou o motivo do clima muda (não repete a cada leitura).
  // A mudança precisa se repetir por algumas leituras seguidas, para o ruído do sensor
  // na borda de uma faixa (ex.: 27,0 / 27,1 / 26,9) não encher a tabela de logs.
  const chaveClima = clima.nivel + '|' + clima.motivos.join('+');
  let confirmou = false;
  if (chaveClima === climaChave) {
    climaPendente = null;
    climaContagem = 0;
  } else {
    if (chaveClima === climaPendente) climaContagem++;
    else { climaPendente = chaveClima; climaContagem = 1; }
    confirmou = climaChave === null || climaContagem >= LEITURAS_PARA_CONFIRMAR;
  }

  if (confirmou) {
    climaChave = chaveClima;
    climaPendente = null;
    climaContagem = 0;
    const motivos = clima.motivos.join(' + ');
    if (clima.nivel === 'IDEAL') {
      registrarLog({ evento: 'CLIMA IDEAL PARA SERVIDOR', classe: 'ok' });
    } else if (clima.nivel === 'ATENCAO') {
      registrarLog({ evento: `CLIMA EM ATENÇÃO: ${motivos}`, classe: 'atencao' });
    } else if (clima.nivel === 'CRITICO') {
      registrarLog({ evento: `CLIMA CRÍTICO: ${motivos}`, classe: 'alerta' });
    } else {
      registrarLog({ evento: 'SENSOR DE TEMPERATURA SEM LEITURA', classe: 'atencao' });
    }
  }

  // ---------- "Tem movimento?" ----------
  if (!movimento) {
    // Não -> "Sem movimento", registra uma vez e não repete
    if (pirEstado !== 'SEM') {
      registrarLog({ pir: 'SEM MOVIMENTO', evento: 'SEM MOVIMENTO', classe: 'ok' });
      pirEstado = 'SEM';
      portaEstado = null;
    }
    return;
  }

  // Sim -> "Movimentação" (indica que tem alguém na sala)
  if (pirEstado !== 'COM') {
    registrarLog({ pir: 'COM MOVIMENTO', evento: 'MOVIMENTAÇÃO: HÁ ALGUÉM NA SALA', classe: 'atencao' });
    pirEstado = 'COM';
    portaEstado = null;
  }

  // ---------- "A porta do rack está aberta?" ----------
  if (portaAberta) {
    // Sim -> "Aberto" + distância em cm; "Dados repetirão até a porta fechar"
    portaEstado = 'ABERTA';
    registrarLog({ porta: 'ABERTA', pir: 'COM MOVIMENTO', distancia: textoDistancia, evento: 'PORTA ABERTA', classe: 'atencao' });
  } else if (portaEstado !== 'FECHADA') {
    // Não -> "Fechado" + "Sem aproximação (porta fechada)", registra uma vez e não repete
    portaEstado = 'FECHADA';
    registrarLog({ porta: 'FECHADA', pir: 'COM MOVIMENTO', distancia: 'SEM APROXIMAÇÃO (PORTA FECHADA)', evento: 'PORTA FECHADA', classe: 'ok' });
  }
}

const mqttClient = mqtt.connect(BROKER_URL);

mqttClient.on('connect', () => {
  console.log('[API] Conectada ao Broker MQTT!');
  mqttClient.subscribe(TOPIC_SENSORS);
});

mqttClient.on('error', (error) => {
  console.error('[MQTT] Erro:', error.message);
});

mqttClient.on('message', (topic, payload) => {
  try {
    const dados = JSON.parse(payload.toString());
    if (dados === null || typeof dados !== 'object') return;

    // Só copiamos os campos conhecidos
    estadoAtual = {
      porta_aberta: dados.porta_aberta === true,
      distancia_cm: Number.isFinite(dados.distancia_cm) ? dados.distancia_cm : null,
      pir_movimento: dados.pir_movimento === true,
      temperatura_c: numeroEntre(dados.temperatura_c, -40, 125),
      umidade_pct: numeroEntre(dados.umidade_pct, 0, 100),
      atualizado_em: new Date().toLocaleString('pt-BR')
    };

    processarLeitura(dados);
  } catch (error) {
    console.error('[API] Erro no JSON:', error.message);
  }
});

// Endpoint dos logs
app.get('/api/sensores/logs', (req, res) => {
  res.json({
    statusAtual: estadoAtual,
    clima: { ...climaAtual, faixas: FAIXAS_CLIMA, historico: historicoClima },
    logs: historicoLogs
  });
});

app.listen(3000, () => {
  console.log('[API] ELO5 System rodando em http://localhost:3000');
});
