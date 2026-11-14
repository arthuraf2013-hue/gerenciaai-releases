// Teclado de toque do Windows nos campos de texto (modo toque).
//
// Com teclado físico ligado (o normal no caixa), o Windows não sobe o
// teclado de toque sozinho ao tocar num campo. Aqui o app pede por ele,
// pelas mesmas interfaces COM que o próprio Windows usa:
//   - ITipInvocation.Toggle (TabTip): mostra/esconde o teclado;
//   - IFrameworkInputPane.Location: onde o teclado está na tela (vazio =
//     escondido) -- é o que impede o Toggle de esconder um teclado que já
//     estava aberto, e diz quanto da janela ele cobre.
//
// Um único PowerShell fica aberto em segundo plano (escondido) recebendo
// os pedidos pela entrada padrão: abrir um a cada toque levaria ~1 s.
// Qualquer falha é silenciosa -- o campo continua funcionando com o
// teclado físico; o pior caso é o teclado de toque não subir.
//
// O script é só ASCII: o PowerShell 5.1 lê .ps1 sem BOM como ANSI.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("37c994e7-432b-4834-a2f7-dce1f13b834b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITipInvocation { void Toggle(IntPtr hwnd); }

[ComImport, Guid("4ce576fa-83dc-4F88-951c-9d0782b4e376")]
class UIHostNoLaunch { }

[ComImport, Guid("5752238B-24F0-495A-82F1-2FD593056796"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFrameworkInputPane {
  [PreserveSig] int Advise([MarshalAs(UnmanagedType.IUnknown)] object pWindow, IntPtr pHandler, out int pdwCookie);
  [PreserveSig] int AdviseWithHWND(IntPtr hwnd, IntPtr pHandler, out int pdwCookie);
  [PreserveSig] int Unadvise(int dwCookie);
  [PreserveSig] int Location(out RetanguloTeclado prcInputPaneScreenLocation);
}

[ComImport, Guid("D5120AA3-46BA-44C5-822D-CA8092C1FC72")]
class FrameworkInputPane { }

[StructLayout(LayoutKind.Sequential)]
public struct RetanguloTeclado { public int Left; public int Top; public int Right; public int Bottom; }

public static class TecladoWin {
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();

  public static string Area() {
    try {
      IFrameworkInputPane p = (IFrameworkInputPane)new FrameworkInputPane();
      RetanguloTeclado r;
      int hr = p.Location(out r);
      Marshal.ReleaseComObject(p);
      if (hr != 0) return "0,0,0,0";
      return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    } catch { return "0,0,0,0"; }
  }

  public static bool Visivel() {
    string[] v = Area().Split(',');
    return int.Parse(v[2]) - int.Parse(v[0]) > 0 && int.Parse(v[3]) - int.Parse(v[1]) > 0;
  }

  public static string Alternar() {
    try {
      ITipInvocation t = (ITipInvocation)new UIHostNoLaunch();
      t.Toggle(GetDesktopWindow());
      Marshal.ReleaseComObject(t);
      return "ok";
    } catch (Exception e) { return "erro " + e.Message; }
  }
}
'@
$tabtip = Join-Path $env:CommonProgramFiles 'microsoft shared\ink\TabTip.exe'
[Console]::Out.WriteLine('PRONTO')
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null -or $l -eq 'sair') { break }
  if ($l -eq 'mostrar') {
    if (-not [TecladoWin]::Visivel()) {
      if ([TecladoWin]::Alternar() -ne 'ok') {
        # O TabTip ainda nao estava rodando: abre e tenta de novo.
        Start-Process -FilePath $tabtip
        Start-Sleep -Milliseconds 700
        if (-not [TecladoWin]::Visivel()) { [void][TecladoWin]::Alternar() }
      }
      Start-Sleep -Milliseconds 350
    }
  } elseif ($l -eq 'esconder') {
    if ([TecladoWin]::Visivel()) { [void][TecladoWin]::Alternar(); Start-Sleep -Milliseconds 250 }
  }
  [Console]::Out.WriteLine('R ' + [TecladoWin]::Area())
}
`;

const ACOES = new Set(['preparar', 'mostrar', 'esconder', 'area']);

/** "R 0,412,1024,768" -> { x, y, width, height } em pixels físicos da tela. */
function lerArea(linha) {
  const m = /^R\s+(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/.exec(String(linha || ''));
  if (!m) return null;
  const [l, t, r, b] = m.slice(1).map(Number);
  return { x: l, y: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
}

/**
 * Quanto do fundo da área da janela (DIP) o teclado (DIP) cobre: do topo
 * do teclado até o fim da janela. 0 = não cobre nada / escondido.
 */
function alturaCoberta(conteudo, area) {
  if (!conteudo || !area || !(area.width > 0) || !(area.height > 0)) return 0;
  const sobrepoeNaLargura = area.x < conteudo.x + conteudo.width && area.x + area.width > conteudo.x;
  if (!sobrepoeNaLargura) return 0;
  const fim = conteudo.y + conteudo.height;
  const topo = Math.max(area.y, conteudo.y);
  if (topo >= fim || area.y + area.height <= conteudo.y) return 0;
  return Math.round(fim - topo);
}

let proc = null;
let pronto = null;
let esperando = []; // quem espera a próxima linha "R ..."
let fila = Promise.resolve();

function iniciar(pastaDados) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (proc) return pronto;
  try {
    const arquivo = path.join(pastaDados, 'teclado-sistema.ps1');
    fs.writeFileSync(arquivo, SCRIPT.replace(/\r?\n/g, '\r\n'), 'ascii');
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', arquivo], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (err) {
    console.error('[teclado-sistema]', err);
    proc = null;
    return Promise.resolve(false);
  }
  const atual = proc;
  let resto = '';
  pronto = new Promise((resolve) => {
    const desistir = setTimeout(() => resolve(false), 20000);
    atual.stdout.setEncoding('utf8');
    atual.stdout.on('data', (pedaco) => {
      resto += pedaco;
      let i;
      while ((i = resto.indexOf('\n')) >= 0) {
        const linha = resto.slice(0, i).trim();
        resto = resto.slice(i + 1);
        if (linha === 'PRONTO') { clearTimeout(desistir); resolve(true); continue; }
        if (linha.startsWith('R ')) esperando.shift()?.(lerArea(linha));
      }
    });
    atual.on('error', (err) => { console.error('[teclado-sistema]', err); });
    atual.on('exit', () => {
      clearTimeout(desistir);
      resolve(false);
      if (proc === atual) proc = null;
      for (const fn of esperando.splice(0)) fn(null);
    });
  });
  return pronto;
}

function enviar(acao) {
  return new Promise((resolve) => {
    if (!proc) { resolve(null); return; }
    const t = setTimeout(() => { const i = esperando.indexOf(feito); if (i >= 0) esperando.splice(i, 1); resolve(null); }, 6000);
    function feito(area) { clearTimeout(t); resolve(area); }
    esperando.push(feito);
    try { proc.stdin.write(`${acao}\n`); } catch { feito(null); }
  });
}

/**
 * Pede ao Windows: 'preparar' (só sobe o processo), 'mostrar', 'esconder'
 * ou 'area'. Um pedido por vez, na ordem.
 * @returns {Promise<{ok:boolean, suportado?:boolean, area?:object|null}>}
 */
function executar(acao, pastaDados) {
  if (!ACOES.has(acao)) return Promise.resolve({ ok: false, error: 'Ação inválida.' });
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, suportado: false, area: null });
  const passo = fila.then(async () => {
    const ok = await iniciar(pastaDados);
    if (!ok) return { ok: false, error: 'Teclado do Windows indisponível.' };
    const area = await enviar(acao === 'preparar' ? 'area' : acao);
    return { ok: area !== null, suportado: true, area };
  });
  fila = passo.catch(() => null);
  return passo;
}

function encerrar() {
  if (!proc) return;
  try { proc.stdin.end('sair\n'); } catch { /* já fechado */ }
  const p = proc;
  setTimeout(() => { try { p.kill(); } catch { /* já saiu */ } }, 1500).unref?.();
  proc = null;
}

module.exports = { executar, encerrar, lerArea, alturaCoberta, SCRIPT };
