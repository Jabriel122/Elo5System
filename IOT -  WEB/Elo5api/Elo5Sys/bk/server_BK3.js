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

// Cartões com permissão (UID -> nome). Qualquer outro UID é negado.
// Os UIDs abaixo são os do cartão azul e do verde do Wokwi.
const CARTOES_AUTORIZADOS = {
  '01:02:03:04': 'Cartão Azul',
  '11:22:33:44': 'Cartão Verde'
};

// 4 a 10 bytes em hexadecimal separados por ":" (o UID vem de fora, então é validado)
const UID_VALIDO = /^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$/;

// =====================================================================
// MÁQUINA DE ESTADOS - segue o fluxo do arquivo Elo5Log.drawio
//
//  OCIOSO : "Máquina NFC com dados vazios", esperando alguém passar o cartão
//  ATIVO  : acesso permitido; o ID do cartão aparece em todos os logs.
//           PIR -> se há movimento, valem a porta e a distância
//  SAINDO : apertou o botão de saída mas deixou a porta aberta;
//           os logs se repetem até a porta fechar, aí volta para OCIOSO
// =====================================================================
const sessao = {
  fase: 'OCIOSO',
  rotulo: null,        // "Cartão Azul (01:02:03:04)" enquanto houver sessão
  pirEstado: null,     // 'SEM' | 'COM' (último estado já registrado)
  portaEstado: null,   // 'FECHADA' | 'ABERTA' (último estado já registrado)
  ociosoLogado: false  // "Nenhum cartão passado" é registrado uma vez só
};

let estadoAtual = {
  porta_aberta: false,
  distancia_cm: null,
  pir_movimento: false,
  atualizado_em: null
};

// Histórico em memória dos últimos 50 logs
let historicoLogs = [];
let seqLog = 0;

function registrarLog({ idNfc, porta = '—', pir = '—', distancia = '—', evento, classe }) {
  const novoLog = {
    id: ++seqLog,
    hora: new Date().toLocaleString('pt-BR'),
    // "O ID do NFC irá aparecer em todos os LOGS" da sessão
    idNfc: idNfc !== undefined ? idNfc : (sessao.rotulo || '—'),
    porta,
    pir,
    distancia,
    decisao: evento,
    statusClass: classe
  };

  historicoLogs.unshift(novoLog);
  if (historicoLogs.length > 50) historicoLogs.pop();

  console.log('[API] Log registrado:', novoLog);
}

function encerrarSessao() {
  sessao.fase = 'OCIOSO';
  sessao.rotulo = null;
  sessao.pirEstado = null;
  sessao.portaEstado = null;
  sessao.ociosoLogado = false;   // volta ao início: registra "Nenhum cartão passado" de novo
}

function processarLeitura(d) {
  const portaAberta = d.porta_aberta === true;
  const movimento   = d.pir_movimento === true;
  const botaoSaida  = d.botao_saida === true;

  const cartao = typeof d.cartao_uid === 'string' ? d.cartao_uid.toUpperCase() : null;
  const cartaoValido = cartao !== null && UID_VALIDO.test(cartao);

  const textoPorta = portaAberta ? 'ABERTA' : 'FECHADA';
  const textoDistancia = Number.isFinite(d.distancia_cm) ? `${d.distancia_cm} cm` : 'FORA DE ALCANCE';

  // ---------- OCIOSO: "Passou o cartão?" ----------
  if (sessao.fase === 'OCIOSO') {
    if (!cartaoValido) {
      // Não -> "Nenhum cartão passado - inserido no LOG" -> Fim (sem repetir)
      if (!sessao.ociosoLogado) {
        registrarLog({ evento: 'NENHUM CARTÃO PASSADO', classe: 'ok' });
        sessao.ociosoLogado = true;
      }
      return;
    }

    // Sim -> "Tem permissão?"
    const nome = CARTOES_AUTORIZADOS[cartao];
    if (!nome) {
      registrarLog({ idNfc: cartao, evento: 'ACESSO NEGADO', classe: 'alerta' });
      sessao.ociosoLogado = true;   // negado: registra uma vez e volta a esperar, sem repetir
      return;
    }

    sessao.fase = 'ATIVO';
    sessao.rotulo = `${nome} (${cartao})`;
    sessao.pirEstado = null;
    sessao.portaEstado = null;
    registrarLog({ evento: `ACESSO PERMITIDO: ${nome}`, classe: 'ok' });
    // segue para os sensores na mesma mensagem: "Ao entrar na sala ativará o sensor PIR"
  }

  // ---------- ATIVO ----------
  if (sessao.fase === 'ATIVO') {
    // "Para sair do Rack tem que apertar o botão"
    if (botaoSaida) {
      registrarLog({ porta: textoPorta, evento: 'ID NFC - SAINDO', classe: 'atencao' });

      if (portaAberta) {
        // "Saiu e deixou a porta aberta" -> sim: continua repetindo os logs
        sessao.fase = 'SAINDO';
        registrarLog({ porta: 'ABERTA', distancia: textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
      } else {
        // não: volta ao início (máquina com dados vazios)
        encerrarSessao();
      }
      return;
    }

    // "Tem movimento?"
    if (!movimento) {
      // Não -> "Sem movimento", registra uma vez e não repete
      if (sessao.pirEstado !== 'SEM') {
        registrarLog({ pir: 'SEM MOVIMENTO', evento: 'SEM MOVIMENTO', classe: 'ok' });
        sessao.pirEstado = 'SEM';
        sessao.portaEstado = null;
      }
      return;
    }

    // Sim -> "Movimentação" (indica que tem alguém na sala)
    if (sessao.pirEstado !== 'COM') {
      registrarLog({ pir: 'COM MOVIMENTO', evento: 'MOVIMENTAÇÃO: HÁ ALGUÉM NA SALA', classe: 'atencao' });
      sessao.pirEstado = 'COM';
      sessao.portaEstado = null;
    }

    // "A porta do rack está aberta?"
    if (portaAberta) {
      // Sim -> "Aberto" + distância em cm; "Dados repetirão até a porta fechar"
      sessao.portaEstado = 'ABERTA';
      registrarLog({ porta: 'ABERTA', pir: 'COM MOVIMENTO', distancia: textoDistancia, evento: 'PORTA ABERTA', classe: 'atencao' });
    } else if (sessao.portaEstado !== 'FECHADA') {
      // Não -> "Fechado" + "Sem aproximação (porta fechada)", registra uma vez e não repete
      sessao.portaEstado = 'FECHADA';
      registrarLog({ porta: 'FECHADA', pir: 'COM MOVIMENTO', distancia: 'SEM APROXIMAÇÃO (PORTA FECHADA)', evento: 'PORTA FECHADA', classe: 'ok' });
    }
    return;
  }

  // ---------- SAINDO: saiu e deixou a porta aberta ----------
  if (sessao.fase === 'SAINDO') {
    if (portaAberta) {
      registrarLog({ porta: 'ABERTA', distancia: textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
    } else {
      registrarLog({ porta: 'FECHADA', evento: 'PORTA FECHADA: SESSÃO ENCERRADA', classe: 'ok' });
      encerrarSessao();
    }
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

    // Só copiamos os campos conhecidos (o broker é público: qualquer um pode publicar)
    estadoAtual = {
      porta_aberta: dados.porta_aberta === true,
      distancia_cm: Number.isFinite(dados.distancia_cm) ? dados.distancia_cm : null,
      pir_movimento: dados.pir_movimento === true,
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
    statusAtual: { ...estadoAtual, fase: sessao.fase, idNfc: sessao.rotulo },
    logs: historicoLogs
  });
});

app.listen(3000, () => {
  console.log('[API] ELO5 System rodando em http://localhost:3000');
});
