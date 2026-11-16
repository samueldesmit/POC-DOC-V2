import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import MerchantApp from './MerchantApp.jsx';
import { text as t } from './i18n.js';
import './styles.css';

// Merchants see the plain overview; the technical release desk stays one click away.
function Root() {
  const [technical, setTechnical] = useState(false);
  return technical
    ? <><div className="m-back"><button className="text-button" onClick={() => setTechnical(false)}>← {t.back}</button></div><App /></>
    : <MerchantApp onTechnical={() => setTechnical(true)} />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Root /></React.StrictMode>);
