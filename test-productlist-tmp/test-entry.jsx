import React from 'react';
import ReactDOM from 'react-dom/client';
import { ProductList } from '../src/components/inventory/ProductList.jsx';

window.APP_LOCATION_ID = 'loc1';

ReactDOM.createRoot(document.getElementById('root')).render(
  <main className="main-content">
    <ProductList />
  </main>
);
