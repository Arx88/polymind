// Barra lateral: la navegación de las dos visiones (usuario y agente).

import { Icon, LogoMark, type IconName } from './Icons';
import { useState } from 'react';

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  href: string;
}

export const NAV: NavItem[] = [
  { key: 'debates', label: 'Trabajos', icon: 'chat', href: '#/' },
  { key: 'agentes', label: 'Agentes', icon: 'users', href: '#/agentes' },
  { key: 'resultados', label: 'Resultados', icon: 'chart', href: '#/resultados' },
  { key: 'plantillas', label: 'Plantillas', icon: 'doc', href: '#/plantillas' },
  { key: 'agente', label: 'Conectar agente', icon: 'bolt', href: '#/agente' },
  { key: 'ajustes', label: 'Ajustes', icon: 'gear', href: '#/ajustes' },
];

export function Sidebar({ active, counts }: { active: string; counts?: Record<string, number> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <aside className={`sidebar${menuOpen ? ' menuOpen' : ''}`}>
      <div className="brand">
        <LogoMark />
        <div>
          <b>Polymind</b>
          
        </div>
      </div>

      <a className="btnPrimary" href="#/nuevo" aria-label="Nuevo trabajo" onClick={() => setMenuOpen(false)}>
        <Icon name="plus" size={17} strokeWidth={2.6} />
        Nuevo trabajo
      </a>

      
      <button className="mobileMenu" aria-expanded={menuOpen} aria-controls="polymind-navigation" onClick={() => setMenuOpen(v => !v)}><Icon name="layers" size={18}/> Menú</button>
      <nav id="polymind-navigation" className="nav" aria-label="Navegación principal">
        {NAV.map(item => (
          <a
            key={item.key}
            href={item.href}
            className={active === item.key ? 'active' : ''}
            aria-current={active === item.key ? 'page' : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => setMenuOpen(false)}
          >
            <Icon name={item.icon} size={20} />
            {item.label}
            {counts?.[item.key] ? <span className="count">{counts[item.key]}</span> : null}
          </a>
        ))}
      </nav>

      <div className="sideFooter">
        <img className="sideIllustration" src="/images/polymind-sidebar.png" alt="" />
        <div className="sideTag">
          Múltiples mentes.<br />Mejores resultados.
        </div>
        
      </div>
    </aside>
  );
}
