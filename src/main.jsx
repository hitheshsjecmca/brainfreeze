import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/projector.css';
import './styles/participant.css';
import './styles/round2.css';
import './styles/round3.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
