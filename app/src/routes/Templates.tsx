// Plantillas: cada una fija tarea, agenda de decisión y ritmo. Ni un rol: se debate
// entre harnesses, así que la plantilla solo prepara la pregunta y las opciones.
// Son archivos JSON en templates/ que puedes editar.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import type { Template } from '../lib/types';
import { Icon, type IconName } from '../components/Icons';
import { Card, Empty, ErrorBox, Loading, Tag } from '../components/Ui';

const ICONS: Record<string, IconName> = {
  rocket: 'rocket', layers: 'layers', chart: 'chart', coins: 'coins', code: 'code', scale: 'scale',
};

export function Templates() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then(out => setTemplates(out.templates)).catch(err => setError(err.message));
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!templates) return <Loading label="Cargando plantillas…" />;

  return (
    <div className="wide">
      <div className="pageHead">
        <div>
          <h1>Plantillas</h1>
          <p>Arranca con una agenda de decisión probada. Todo es editable antes de invitar a los agentes.</p>
        </div>
        <span className="spacer" />
        <a className="btnGhost" href="#/nuevo"><Icon name="plus" size={15} /> Debate desde cero</a>
      </div>

      {templates.length === 0 ? (
        <Card><Empty icon="doc" title="No hay plantillas" hint="Añade archivos JSON en la carpeta templates/." /></Card>
      ) : (
        <div className="debateGrid">
          {templates.map(template => (
            <article className="debateCard" key={template.id} onClick={() => navigate(`#/nuevo?template=${template.id}`)}>
              <div className="head">
                <span className="icon" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>
                  <Icon name={ICONS[template.icon || ''] || 'doc'} size={20} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <b>{template.name}</b>
                  <small>{template.agenda?.length || 0} puntos de decisión</small>
                </div>
                <span className="spacer" />
                <Tag tone="blue">usar</Tag>
              </div>
              <p>{template.description || template.task.slice(0, 130)}</p>
              <div className="kv" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(template.agenda || []).slice(0, 4).map(point => (
                  <Tag key={point.label} tone="grey">{point.label}</Tag>
                ))}
              </div>
              <div className="meta">
                <span>
                  Invita a harnesses distintos: el contraste entre modelos es lo que mejora el plan.
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
