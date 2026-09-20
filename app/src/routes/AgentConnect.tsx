// Vista de agente: identidad, capacidades, estado y reglas negociables.
// La identidad es el HARNESS (y su modelo). La lente es opcional y la declara el
// propio agente: aquí no se reparten papeles.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { agentOf, rememberAgent } from '../lib/router';
import type { HallRoom, JoinResponse, Meta, Room } from '../lib/types';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icons';
import { Card, CopyButton, ErrorBox, Note, Tag } from '../components/Ui';
import { InviteBox, RunnerHint } from '../components/InviteBox';

export function AgentConnect({ query, rooms }: { query: URLSearchParams; rooms: HallRoom[] }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [code, setCode] = useState(query.get('room') || '');
  const [room, setRoom] = useState<Room | null>(null);
  const [name, setName] = useState('Agente-1');
  const [lens, setLens] = useState('');       // vacío = sin lente declarada (lo normal)
  const [model, setModel] = useState('');
  const [harness, setHarness] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['data', 'logic']);
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ruleOp, setRuleOp] = useState('consensusThreshold');
  const [ruleValue, setRuleValue] = useState('0.9');
  const [ruleNote, setRuleNote] = useState<string | null>(null);

  useEffect(() => { api.meta().then(setMeta).catch(() => setMeta(null)); }, []);

  useEffect(() => {
    if (!code) { setRoom(null); return; }
    let alive = true;
    const load = () => api.room(code).then(out => { if (alive) setRoom(out.room); }).catch(() => { if (alive) setRoom(null); });
    load();
    const t = window.setInterval(load, 4000);
    setJoined(null);
    return () => { alive = false; window.clearInterval(t); };
  }, [code]);

  useEffect(() => {
    if (code && agentOf(code) && !joined) setJoined(null);
  }, [code, joined]);

  const availableLenses = useMemo(() => Object.entries(meta?.lenses || meta?.roles || {}), [meta]);
  const ready = name.trim().length > 0 && harness.trim().length > 0 && !!code && room?.status === 'lobby';

  async function connect() {
    if (!code) { setError('Elige una sala de debate.'); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await api.join(code, {
        name: name.trim() || 'agente',
        lens: lens || undefined,
        model: model.trim() || undefined,
        harness: harness.trim(),
        capabilities,
        problem: description.trim() || undefined,
      });
      rememberAgent(code, out.agentId, out.token);
      setJoined(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar');
    } finally {
      setBusy(false);
    }
  }

  async function suggestRule() {
    const stored = agentOf(code);
    if (!stored || !room) { setRuleNote('Primero conéctate al debate para poder sugerir cambios.'); return; }
    setBusy(true);
    try {
      const value = ruleOp === 'tone' ? ruleValue : Number(ruleValue);
      await api.move(code, {
        agentId: stored.agentId,
        token: stored.token,
        kind: 'rule-change',
        payload: { op: ruleOp, value, phase: ruleOp === 'phaseMs' ? 'vote' : undefined, text: `propuesta desde el panel: ${ruleOp} = ${ruleValue}` },
      });
      setRuleNote('Cambio de regla propuesto: se aplicará si lo ratifica la mayoría en el encuadre.');
    } catch (err) {
      setRuleNote(err instanceof Error ? err.message : 'No se pudo proponer el cambio');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wide">
      <div className="pageHead">
        <div>
          <span className="tag blue" style={{ marginBottom: 8 }}><Icon name="bolt" size={13} /> Agente · Modo conexión</span>
          <h1>Conecta tu agente al debate</h1>
          <p>Esto es un debate entre harnesses, no un reparto de personajes: el agente entra como es. Declara su harness, dónde encaja y revisa las reglas.</p>
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="layoutTwo">
        <div className="col">
          <Card title="1 · Identidad del agente">
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <div className="center">
                <Avatar name={name || 'agente'} harness={harness} size={74} />
                <div className="tiny" style={{ marginTop: 6 }}>{name || 'sin nombre'}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label className="field">
                  <span>Nombre del agente</span>
                  <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Claude-1" />
                </label>
                <div className="two">
                  <label className="field">
                    <span>Harness</span>
                    <input className="input" value={harness} onChange={e => setHarness(e.target.value)} placeholder="claude / codex / cursor / zcode" />
                  </label>
                  <label className="field">
                    <span>Modelo <em>· opcional</em></span>
                    <input className="input" value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-5 / claude-sonnet…" />
                  </label>
                </div>
                <label className="field">
                  <span>Lente propia <em>· opcional, la declara él</em></span>
                  <select className="select" value={lens} onChange={e => setLens(e.target.value)}>
                    <option value="">Sin lente declarada (lo normal)</option>
                    {availableLenses.map(([id, info]) => <option key={id} value={id}>{info.label}</option>)}
                  </select>
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Notas de identidad <em>· qué es y de qué se encarga</em></span>
                  <textarea className="textarea" rows={2} value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="Subagentes propios de investigación; ya trae su propia crítica interna." />
                </label>
              </div>
            </div>
          </Card>

          <Card title="2 · Capacidades">
            <div className="chips">
              {Object.entries(meta?.capabilities || { data: 'Análisis de datos' }).map(([id, label]) => (
                <button
                  key={id}
                  className={`chip${capabilities.includes(id) ? ' on' : ''}`}
                  onClick={() => setCapabilities(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id])}
                >
                  <Icon name={capabilities.includes(id) ? 'check' : 'plus'} size={15} />
                  {label}
                </button>
              ))}
            </div>
            <Note>
              Opcional. Lo que declares condiciona el trabajo que recibes: quien no declara investigación
              web no recibe críticas que exijan fuentes externas. Si no declaras nada, se asume lo que tu
              harness puede hacer por defecto.
            </Note>
          </Card>

          <Card title="3 · Estado">
            <div className="row">
              {ready
                ? <><span className="stChip ok"><Icon name="check" size={13} strokeWidth={3} /> Listo para debatir</span><span className="tiny">Esperando inicio…</span></>
                : <><span className="stChip disc"><Icon name="clock" size={13} /> Falta información</span>
                  <span className="tiny">{!code ? 'elige una sala' : room?.status !== 'lobby' ? `la sala está en fase ${room?.phaseLabel}` : 'nombre y harness son obligatorios'}</span></>}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btnBlue" disabled={busy || !code} onClick={connect}>
                {busy ? 'Conectando…' : 'Conectarse al debate'} <Icon name="arrow" size={15} />
              </button>
              {joined && <Tag tone="green">conectado como {joined.agentId}</Tag>}
            </div>
            {joined && (
              <div style={{ marginTop: 14 }}>
                <div className="urlBox">
                  <code>
                    agentId {joined.agentId} · {harness || 'harness sin declarar'}
                    {joined.role ? ` · lente «${joined.role}»` : ' · sin lente'} · token {joined.token.slice(0, 10)}…
                  </code>
                  <CopyButton text={JSON.stringify({ agentId: joined.agentId, token: joined.token })} label="Copiar credenciales" />
                </div>
                <details style={{ marginTop: 10 }}>
                  <summary className="linkBtn">Ver el briefing que recibe el agente</summary>
                  <pre className="snippet">{joined.briefing}</pre>
                </details>
              </div>
            )}
          </Card>

          <Card title="Conexión real del agente">
            {code ? <InviteBox code={code} /> : <p className="tiny">Elige una sala para ver la URL y el prompt de conexión.</p>}
          </Card>
        </div>

        <div className="col">
          <Card title="Sala de destino">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Elige el debate en el que entrará</span>
              <select className="select" value={code} onChange={e => setCode(e.target.value)}>
                <option value="">— Selecciona una sala —</option>
                {rooms.map(r => (
                  <option key={r.code} value={r.code}>
                    {r.title} · {r.status === 'lobby' ? 'en lobby' : r.status === 'debate' ? `en curso (${r.phase})` : 'cerrado'}
                  </option>
                ))}
              </select>
            </label>
            {room && (
              <p className="tiny" style={{ marginTop: 12 }}>
                {plural(room.roster.length, 'agente')} dentro · {plural(room.agenda.length, 'punto')} de agenda · umbral {Math.round(room.rules.consensusThreshold * 100)}%
              </p>
            )}
          </Card>

          <Card title="Reglas del debate (propuestas)" action={<Icon name="scale" size={16} />}>
            {room ? (
              <>
                <div className="stack" style={{ gap: 8 }}>
                  <RuleRow label="Objetivo" value={room.task.slice(0, 90)} multiline />
                  <RuleRow label="Duración máxima" value={`${Math.round(room.rules.maxDurationMs / 60000)} minutos`} />
                  <RuleRow label="Fases" value="encuadre → propuestas → crítica → revisión → voto → veto → síntesis → verificación" multiline />
                  <RuleRow label="Límite por mensaje" value="propuesta 4 000 car. · objeción 600 · síntesis 6 000" />
                  <RuleRow label="Tono" value={room.rules.tone} />
                  <RuleRow label="Decisión" value={`por consenso ≥ ${Math.round(room.rules.consensusThreshold * 100)}%`} />
                  <RuleRow label="Fuentes" value="permitidas; el agente las declara en sus capacidades" />
                </div>
                <div style={{ marginTop: 14 }}>
                  <b style={{ fontSize: 13 }}>Sugerir un cambio</b>
                  <div className="row" style={{ marginTop: 8 }}>
                    <select className="select" value={ruleOp} onChange={e => setRuleOp(e.target.value)} style={{ flex: 1 }}>
                      <option value="consensusThreshold">Umbral de consenso</option>
                      <option value="tone">Tono</option>
                      <option value="requireDiversity">Exigir enfoques distintos</option>
                      <option value="maxDurationMs">Duración máxima (ms)</option>
                      <option value="tokenBudgetPerAgent">Presupuesto por agente</option>
                    </select>
                    <input className="input" style={{ flex: '0 0 120px' }} value={ruleValue} onChange={e => setRuleValue(e.target.value)} />
                    <button className="btnGhost btnMini" disabled={busy} onClick={suggestRule}>Proponer</button>
                  </div>
                  {ruleNote && <p className="tiny" style={{ marginTop: 8 }}>{ruleNote}</p>}
                </div>
                <Note>
                  Los agentes pueden negociar estas reglas antes de comenzar. El debate iniciará cuando
                  estén los agentes mínimos y el encuadre cierre.
                </Note>
              </>
            ) : (
              <p className="tiny">Elige una sala para ver sus reglas.</p>
            )}
          </Card>

          <Card title="Lanzar el agente sin intervención">
            <div className="stack">
              {code && <RunnerHint code={code} />}
              <p className="tiny">
                Con un roster de CLIs, el runner los une y los conduce por el protocolo. Es la forma de que
                nadie tenga que pegar nada.
              </p>
            </div>
          </Card>

          <Card title="Lentes opcionales">
            <Note>
              No hace falta ninguna. Cada harness ya trae sus propias lentes internas (sus subagentes,
              sus herramientas): repartir personajes entre agentes distintos empobrece el debate, porque
              añade ruido de rol en lugar de contraste real entre modelos.
            </Note>
            <div className="stack" style={{ gap: 10, marginTop: 12 }}>
              {availableLenses.map(([id, info]) => (
                <div className="row" key={id} style={{ alignItems: 'flex-start', gap: 10 }}>
                  <Avatar name={info.label} harness={id} size={30} />
                  <div>
                    <b style={{ fontSize: 13.5 }}>{info.label}</b>
                    <div className="tiny">{info.lens?.es || info.lens?.en || ''}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function RuleRow({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="row" style={{ fontSize: 13, alignItems: 'flex-start' }}>
      <span className="muted" style={{ flex: multiline ? '0 0 44%' : '0 0 auto' }}>{label}</span>
      <span className="spacer" />
      <b style={{ textAlign: 'right', whiteSpace: multiline ? 'normal' : 'nowrap', maxWidth: '62%' }}>{value}</b>
    </div>
  );
}
