// Ponto de entrada empacotado (esbuild) pelos testes de tela: o painel de
// mesas de verdade, com o servidor, os avisos e o Pix trocados por versões
// falsas (ver telas.test.js).
export { default as PainelMesas } from '../../src/mesas/PainelMesas.jsx';
export * as servidor from './servidorFalso.js';
export { toasts } from './utilFalso.js';
export { createElement } from 'react';
export { act } from 'react';
export { createRoot } from 'react-dom/client';
