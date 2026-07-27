import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

window.APP_DEVICE_ID = window.APP_DEVICE_ID || (() => {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('deviceId', id);
  }
  return id;
})();

// O local (loja) real é criado no seed do banco (ver electron/db/database.js)
// e nunca existiu em localStorage — buscamos o id de verdade antes de
// renderizar, em vez de depender de uma chave que nunca era gravada.
async function bootstrap() {
  try {
    const settings = await window.pdv.settings.get();
    window.APP_LOCATION_ID = settings.location.id;
  } catch (err) {
    console.error('Falha ao carregar as configurações iniciais do app:', err);
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
