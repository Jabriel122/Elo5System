const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Servir os arquivos do site (index.html, camera.html, estilo.css) da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// BROKER_URL só é usada para testes locais; normalmente vale o HiveMQ
const BROKER_URL = process.env.BROKER_URL || 'mqtt://broker.hivemq.com:1883';

// O projeto tem dois ESPs, cada um publicando no seu tópico:
//   ESP do RACK : porta, PIR, distância, temperatura e umidade
//   ESP do NFC  : cartao_uid (cartão aproximado) e botao_saida (botão de saída)
// Os tópicos precisam ser IGUAIS aos dos sketches (MQTT_TOPIC de cada um).
const TOPIC_SENSORS = 'elo5-system/sensores/dados';
const TOPIC_NFC     = 'elo5-system/nfc/eventos';

// =====================================================================
// MODO DO CARTÃO NFC
//   true  = segue o fluxo completo do Elo5Log.drawio: os sensores só valem
//           depois que um cartão autorizado é passado no ESP do NFC.
//   false = os sensores (PIR, porta, distância) valem sempre, mesmo sem o ESP
//           do NFC ligado (útil para testar só o ESP do rack). O cartão e o
//           botão continuam funcionando quando chegam.
// =====================================================================
const EXIGIR_CARTAO = true;

// Cartões autorizados (UID -> dados). Qualquer outro UID é registrado como NEGADO.
// "matricula" e "pessoa" aparecem na página da câmera (ex.: "1708063 - James").
const CARTOES_AUTORIZADOS = {
  '01:02:03:04': { rotulo: 'Cartão Azul',  matricula: '1708063', pessoa: 'James' },
  '11:22:33:44': { rotulo: 'Cartão Verde', matricula: null,      pessoa: null }
};

// 4 a 10 bytes em hexadecimal separados por ":" (o UID vem de fora, então é validado)
const UID_VALIDO = /^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$/;

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
// ÚLTIMAS LEITURAS DOS SENSORES
// Cada ESP manda só os seus campos (o do NFC não sabe se a porta está aberta, por
// exemplo), então cada mensagem atualiza apenas os campos que trouxe e o resto
// vale pela última leitura recebida do outro ESP.
// =====================================================================
const CAMPOS_SENSOR = ['porta_aberta', 'pir_movimento', 'distancia_cm', 'temperatura_c', 'umidade_pct'];
const ultimasLeituras = {
  porta_aberta: false,
  pir_movimento: false,
  distancia_cm: null,
  temperatura_c: null,
  umidade_pct: null
};

// =====================================================================
// CLIMA DA SALA (painel da página)
// A situação só muda depois de 3 leituras seguidas, para o ruído do sensor
// na borda de uma faixa (ex.: 27,0 / 27,1 / 26,9) não ficar piscando.
// =====================================================================
const LEITURAS_PARA_CONFIRMAR = 3;
const MAX_HISTORICO_CLIMA = 300;   // ~5 min a 1 leitura por segundo

let climaEstavel = { chave: null, nivel: null, motivos: [] };
let climaPendente = null;
let climaContagem = 0;
let climaAtual = { temperatura: null, umidade: null, nivel: null, motivos: [] };
let historicoClima = [];

function atualizarClima(s) {
  const temp = numeroEntre(s.temperatura_c, -40, 125);
  const umid = numeroEntre(s.umidade_pct, 0, 100);
  const clima = classificarClima(temp, umid);

  if (temp !== null && umid !== null) {
    historicoClima.push({ t: Date.now(), temp, umid });
    if (historicoClima.length > MAX_HISTORICO_CLIMA) historicoClima.shift();
  }

  const chave = clima.nivel + '|' + clima.motivos.join('+');
  if (chave === climaEstavel.chave) {
    climaPendente = null;
    climaContagem = 0;
  } else {
    if (chave === climaPendente) climaContagem++;
    else { climaPendente = chave; climaContagem = 1; }

    if (climaEstavel.chave === null || climaContagem >= LEITURAS_PARA_CONFIRMAR) {
      climaEstavel = { chave, nivel: clima.nivel, motivos: clima.motivos };
      climaPendente = null;
      climaContagem = 0;
    }
  }

  climaAtual = { temperatura: temp, umidade: umid, nivel: climaEstavel.nivel, motivos: climaEstavel.motivos };
}

// =====================================================================
// LOGS DO RACK - segue o fluxo do arquivo Elo5Log.drawio
//
//  OCIOSO : esperando alguém passar o cartão (só existe com EXIGIR_CARTAO = true)
//  ATIVO  : sensores valem. Com cartão, o ID aparece em todos os logs da sessão.
//           PIR: sem movimento -> registra uma vez; com movimento -> vale a porta:
//             porta aberta  -> registra "aberta" + distância e REPETE até fechar
//             porta fechada -> registra "fechada" uma vez só
//  SAINDO : apertou o botão de saída mas deixou a porta aberta; os logs se
//           repetem até a porta fechar, aí a sessão termina
// =====================================================================
const sessao = {
  fase: EXIGIR_CARTAO ? 'OCIOSO' : 'ATIVO',
  uid: null,
  rotulo: null,
  pessoa: null,         // "1708063 - James" (usado na página da câmera)
  pirEstado: null,      // 'SEM' | 'COM' (último estado já registrado)
  portaEstado: null,    // 'FECHADA' | 'ABERTA' (último estado já registrado)
  ociosoLogado: false   // "Nenhum cartão passado" é registrado uma vez só
};

function resetarSessao() {
  sessao.fase = EXIGIR_CARTAO ? 'OCIOSO' : 'ATIVO';
  sessao.uid = null;
  sessao.rotulo = null;
  sessao.pessoa = null;
  sessao.pirEstado = null;
  sessao.portaEstado = null;
  sessao.ociosoLogado = false;
}

// Histórico em memória (os mais novos primeiro)
const MAX_LOGS = 1000;
let historicoLogs = [];
let seqLog = 0;

// Se cartaoUid não for informado, o log usa o cartão da sessão atual
function registrarLog({ cartaoUid, idNfc, pessoa, porta = '—', movimento = '—', aproximacao = '—', evento, classe }) {
  const daSessao = cartaoUid === undefined;

  const novoLog = {
    id: ++seqLog,
    ts: Date.now(),
    cartaoUid: daSessao ? sessao.uid : cartaoUid,
    idNfc: daSessao ? (sessao.rotulo ? `${sessao.rotulo} (${sessao.uid})` : '—') : idNfc,
    pessoa: daSessao ? sessao.pessoa : (pessoa || null),
    porta,
    movimento,
    aproximacao,
    decisao: evento,
    statusClass: classe
  };

  historicoLogs.unshift(novoLog);
  if (historicoLogs.length > MAX_LOGS) historicoLogs.pop();

  console.log('[API] Log registrado:', novoLog);
}

function processarRack(s, ev) {
  const portaAberta = s.porta_aberta === true;
  const movimento   = s.pir_movimento === true;
  const textoPorta  = portaAberta ? 'ABERTA' : 'FECHADA';
  const textoMov    = movimento ? 'MOVIMENTAÇÃO' : '—';
  const textoDistancia = Number.isFinite(s.distancia_cm) ? `${s.distancia_cm} cm` : 'FORA DE ALCANCE';

  // ---------- "Passou o cartão?" (também aceito numa sessão sem cartão) ----------
  const podeLerCartao = sessao.fase === 'OCIOSO' || (sessao.fase === 'ATIVO' && sessao.uid === null);
  if (ev.cartao && podeLerCartao) {
    const info = CARTOES_AUTORIZADOS[ev.cartao];

    if (!info) {
      // Sem permissão -> "Acesso negado" nos logs
      registrarLog({ cartaoUid: ev.cartao, idNfc: ev.cartao, evento: 'ACESSO NEGADO', classe: 'alerta' });
      if (sessao.fase === 'OCIOSO') sessao.ociosoLogado = true;
      return;
    }

    // Com permissão -> "Acesso permitido" + o ID do cartão em todos os logs seguintes
    sessao.fase = 'ATIVO';
    sessao.uid = ev.cartao;
    sessao.rotulo = info.rotulo;
    sessao.pessoa = info.pessoa ? (info.matricula ? `${info.matricula} - ${info.pessoa}` : info.pessoa) : null;
    sessao.pirEstado = null;
    sessao.portaEstado = null;
    registrarLog({ evento: 'ACESSO PERMITIDO', classe: 'ok' });
    // segue para os sensores na mesma mensagem: "Ao entrar na sala ativará o sensor PIR"
  }

  // ---------- OCIOSO: "Nenhum cartão passado" ----------
  if (sessao.fase === 'OCIOSO') {
    if (!sessao.ociosoLogado) {
      registrarLog({ evento: 'NENHUM CARTÃO PASSADO', classe: 'ok' });
      sessao.ociosoLogado = true;
    }
    return;
  }

  // ---------- SAINDO: saiu e deixou a porta aberta ----------
  if (sessao.fase === 'SAINDO') {
    if (portaAberta) {
      registrarLog({ porta: 'ABERTA', movimento: textoMov, aproximacao: textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
    } else {
      registrarLog({ porta: 'FECHADA', movimento: textoMov, evento: 'PORTA FECHADA', classe: 'ok' });
      resetarSessao();
    }
    return;
  }

  // ---------- ATIVO ----------
  // "Para sair do Rack tem que apertar o botão"
  if (ev.botaoSaida) {
    registrarLog({ porta: textoPorta, evento: 'ID NFC - SAINDO', classe: 'atencao' });

    if (portaAberta) {
      // "Saiu e deixou a porta aberta" -> os logs continuam repetindo
      sessao.fase = 'SAINDO';
      registrarLog({ porta: 'ABERTA', movimento: textoMov, aproximacao: textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
    } else {
      resetarSessao();
    }
    return;
  }

  // "Tem movimento?"
  if (!movimento) {
    // Não -> "Sem movimento", registra uma vez e não repete
    if (sessao.pirEstado !== 'SEM') {
      registrarLog({ movimento: 'SEM MOVIMENTO', evento: 'SEM MOVIMENTO', classe: 'ok' });
      sessao.pirEstado = 'SEM';
      sessao.portaEstado = null;
    }
    return;
  }

  // Sim -> "Movimentação" (indica que tem alguém na sala)
  if (sessao.pirEstado !== 'COM') {
    registrarLog({ movimento: 'MOVIMENTAÇÃO', evento: 'HÁ ALGUÉM NA SALA', classe: 'atencao' });
    sessao.pirEstado = 'COM';
    sessao.portaEstado = null;
  }

  // "A porta do rack está aberta?"
  if (portaAberta) {
    // Sim -> "Aberto" + distância em cm; "Dados repetirão até a porta fechar"
    sessao.portaEstado = 'ABERTA';
    registrarLog({ porta: 'ABERTA', movimento: 'MOVIMENTAÇÃO', aproximacao: textoDistancia, evento: 'PORTA ABERTA', classe: 'atencao' });
  } else if (sessao.portaEstado !== 'FECHADA') {
    // Não -> "Fechado" + "Sem aproximação (porta fechada)", registra uma vez e não repete
    sessao.portaEstado = 'FECHADA';
    registrarLog({ porta: 'FECHADA', movimento: 'MOVIMENTAÇÃO', aproximacao: 'PORTA FECHADA', evento: 'PORTA FECHADA', classe: 'ok' });
  }
}

const mqttClient = mqtt.connect(BROKER_URL);

mqttClient.on('connect', () => {
  console.log('[API] Conectada ao Broker MQTT!');
  mqttClient.subscribe([TOPIC_SENSORS, TOPIC_NFC]);
});

mqttClient.on('error', (error) => {
  console.error('[MQTT] Erro:', error.message);
});

mqttClient.on('message', (topic, payload) => {
  try {
    const dados = JSON.parse(payload.toString());
    if (dados === null || typeof dados !== 'object') return;

    // Só os campos que a mensagem trouxe atualizam as últimas leituras
    for (const campo of CAMPOS_SENSOR) {
      if (campo in dados) ultimasLeituras[campo] = dados[campo];
    }

    // Eventos do ESP do NFC (valem só para esta mensagem, não são guardados)
    const cartao = typeof dados.cartao_uid === 'string' ? dados.cartao_uid.toUpperCase() : null;
    const ev = {
      cartao: cartao !== null && UID_VALIDO.test(cartao) ? cartao : null,
      botaoSaida: dados.botao_saida === true
    };

    if ('temperatura_c' in dados || 'umidade_pct' in dados) atualizarClima(ultimasLeituras);
    processarRack(ultimasLeituras, ev);
  } catch (error) {
    console.error('[API] Erro no JSON:', error.message);
  }
});

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
const STATUS_VALIDOS = ['ok', 'atencao', 'alerta'];

function numeroDaQuery(valor) {
  return typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor)) ? Number(valor) : null;
}

function cartoesVistos() {
  const mapa = new Map();
  for (const log of historicoLogs) {
    if (log.cartaoUid && !mapa.has(log.cartaoUid)) {
      const info = CARTOES_AUTORIZADOS[log.cartaoUid];
      mapa.set(log.cartaoUid, {
        uid: log.cartaoUid,
        rotulo: info ? `${info.rotulo} (${log.cartaoUid})` : `${log.cartaoUid} (negado)`
      });
    }
  }
  return [...mapa.values()];
}

// Logs com filtros opcionais na URL:
//   de, ate      : intervalo (milissegundos desde 1970)
//   status       : ok, atencao, alerta (separados por vírgula)
//   cartao       : UID do cartão, ou "_nenhum" para logs sem cartão
//   portaAberta  : 1 = só logs com a porta aberta
//   limite       : máximo de linhas devolvidas (padrão 200, máximo 500)
app.get('/api/sensores/logs', (req, res) => {
  const q = req.query || {};

  const de = numeroDaQuery(q.de);
  const ate = numeroDaQuery(q.ate);
  const status = typeof q.status === 'string' ? q.status.split(',').filter(s => STATUS_VALIDOS.includes(s)) : [];
  const cartao = typeof q.cartao === 'string' ? q.cartao.toUpperCase() : '';
  const soPortaAberta = q.portaAberta === '1';
  const limite = Math.min(Math.max(parseInt(q.limite, 10) || 200, 1), 500);

  const filtrados = historicoLogs.filter(log =>
    (de === null || log.ts >= de) &&
    (ate === null || log.ts <= ate) &&
    (status.length === 0 || status.includes(log.statusClass)) &&
    (cartao === '' || (cartao === '_NENHUM' ? log.cartaoUid === null : log.cartaoUid === cartao)) &&
    (!soPortaAberta || log.porta === 'ABERTA')
  );

  res.json({
    logs: filtrados.slice(0, limite),
    total: filtrados.length,
    totalGeral: historicoLogs.length,
    cartoes: cartoesVistos(),
    rack: { fase: sessao.fase, idNfc: sessao.rotulo ? `${sessao.rotulo} (${sessao.uid})` : null },
    clima: { ...climaAtual, faixas: FAIXAS_CLIMA, historico: historicoClima }
  });
});

// Último log registrado (usado na página da câmera)
app.get('/api/sensores/ultimo', (req, res) => {
  res.json({
    ultimoLog: historicoLogs[0] || null,
    rack: { fase: sessao.fase, idNfc: sessao.rotulo ? `${sessao.rotulo} (${sessao.uid})` : null }
  });
});

app.listen(3000, () => {
  console.log('[API] ELO5 System rodando em http://localhost:3000');
});