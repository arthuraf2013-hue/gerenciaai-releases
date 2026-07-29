const { getDb } = require('../db/database');

/**
 * ⚠️ ATENÇÃO — esta parte não foi testada contra uma balança digital
 * real (não há esse hardware disponível no ambiente onde este código
 * foi escrito). A lógica de conexão serial segue a documentação
 * oficial do pacote `serialport`, e a extração de peso usa uma
 * abordagem genérica (procura o primeiro número decimal no que a
 * balança manda) que costuma funcionar com protocolos simples de saída
 * contínua em texto — mas cada fabricante/modelo pode variar. TESTE
 * com a balança real antes de confiar nisso no dia a dia — ver
 * BALANCA.md.
 */

let portaAtiva = null;
let ultimoPeso = null;
let ultimoErro = null;

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM scale_hardware_config WHERE id = ?').get('default');
}

function updateConfig({ porta, baudRate, protocolo }) {
  const db = getDb();
  const current = getConfig();
  db.prepare('UPDATE scale_hardware_config SET porta = ?, baud_rate = ?, protocolo = ? WHERE id = ?').run(
    porta !== undefined ? (porta || null) : current.porta,
    baudRate !== undefined ? baudRate : current.baud_rate,
    protocolo !== undefined ? protocolo : current.protocolo,
    'default'
  );
  desconectar();
  return { ok: true };
}

/** Lista as portas seriais disponíveis no PC, pra escolher qual é a da
 * balança nas Configurações. */
async function listPorts() {
  const { SerialPort } = require('serialport');
  const portas = await SerialPort.list();
  return portas.map((p) => ({ caminho: p.path, fabricante: p.manufacturer || '' }));
}

/** Extrai o primeiro número decimal encontrado no texto recebido da
 * balança — abordagem genérica que cobre a maioria dos protocolos
 * simples de saída contínua em ASCII. Se a balança manda algo fora
 * desse padrão, essa função vai precisar de ajuste específico pro
 * modelo (ver BALANCA.md). */
function extrairPeso(textoRecebido) {
  const match = textoRecebido.match(/(-?\d+[.,]\d+)/);
  if (!match) return null;
  const numero = Number(match[1].replace(',', '.'));
  if (Number.isNaN(numero)) return null;
  return numero;
}

/** Conecta na porta configurada e começa a escutar o peso em tempo
 * real. Chamado quando o PDV abre a tela de pesagem — não fica
 * conectado o tempo todo pra não prender a porta serial sem necessidade. */
function conectar() {
  const config = getConfig();
  if (!config.porta) return { ok: false, error: 'Nenhuma porta serial configurada — veja Configurações → Balança.' };
  if (portaAtiva) return { ok: true, jaConectada: true };

  try {
    const { SerialPort } = require('serialport');
    portaAtiva = new SerialPort({ path: config.porta, baudRate: config.baud_rate || 9600 });

    portaAtiva.on('data', (data) => {
      const peso = extrairPeso(data.toString('utf-8'));
      if (peso !== null) {
        ultimoPeso = peso;
        ultimoErro = null;
      }
    });

    portaAtiva.on('error', (err) => {
      ultimoErro = err.message;
    });

    return { ok: true };
  } catch (err) {
    ultimoErro = err.message;
    return { ok: false, error: err.message };
  }
}

function desconectar() {
  if (portaAtiva) {
    try { portaAtiva.close(); } catch (err) { /* já pode estar fechada */ }
    portaAtiva = null;
  }
  ultimoPeso = null;
  ultimoErro = null;
}

/** Checagem local rápida — não faz nada na porta serial, só devolve o
 * último peso lido (ou erro). */
function getLeituraAtual() {
  return { conectada: !!portaAtiva, pesoKg: ultimoPeso, erro: ultimoErro };
}

module.exports = { getConfig, updateConfig, listPorts, conectar, desconectar, getLeituraAtual, extrairPeso };
