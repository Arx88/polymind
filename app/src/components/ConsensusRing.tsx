// Anillo de consenso: refleja el consenso REAL por puntos de la agenda
// (no un adorno). El color cambia con el estado.

import { Icon } from './Icons';
import { MACRO_LABEL, MACRO_ORDER, MACRO_PHASES, PHASE_LABEL, pct0 } from '../lib/format';
import type { ConsensusStage, Phase, Room } from '../lib/types';

export function ConsensusRing({ value, size = 132, caption = 'Consenso', sub }: {
  value: number;
  size?: number;
  caption?: string;
  sub?: string;
}) {
  const stroke = 13;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value || 0));
  const color = clamped >= 0.75 ? '#16a34a' : clamped >= 0.5 ? '#2563eb' : '#f59e0b';
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef2f9" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * clamped} ${circumference}`}
          style={{ transition: 'stroke-dasharray .5s ease' }}
        />
      </svg>
      <div className="ringLabel">
        <b>{pct0(clamped)}</b>
        <small>{caption}</small>
        {sub && <small style={{ color: 'var(--sub2)', fontWeight: 600 }}>{sub}</small>}
      </div>
    </div>
  );
}

// Checklist de las 4 macro-etapas, con las fases reales dentro.
export function PhaseChecklist({ room }: { room: Room }) {
  const currentMacro = room.macro;
  const currentIndex = MACRO_ORDER.indexOf(currentMacro);
  const done = room.status === 'closed';
  const report = room.consensus;

  return (
    <div className="checkList">
      {MACRO_ORDER.map((macro, i) => {
        const isDone = done || i < currentIndex;
        const isNow = !done && i === currentIndex;
        const extra = macro === 'synthesis' && isNow ? pct0(report.global) : null;
        return (
          <div key={macro} className={`checkRow${isDone ? ' done' : isNow ? ' now' : ''}`}>
            <span className="ic">{isDone ? <Icon name="check" size={12} strokeWidth={3} /> : i + 1}</span>
            <span>{MACRO_LABEL[macro]}</span>
            <span className="val">{extra ?? (isDone ? <Icon name="check" size={15} strokeWidth={3} /> : '')}</span>
          </div>
        );
      })}
    </div>
  );
}

// Consenso por etapa: la evolución, no solo el número de ahora. Cada barra dice en qué
// etapa se midió y cuántos puntos seguían abiertos; la etapa en curso va marcada, y una
// etapa sin agenda que medir lo dice en vez de fingir un 0%.
export function StageConsensus({ stages, threshold }: { stages: ConsensusStage[]; threshold: number }) {
  if (!stages?.length) return null;
  return (
    <div className="stageList">
      {stages.map(stage => {
        // La etapa de trabajo se lee con su tablero: «0/5 integradas», no un porcentaje que parece
        // la nota del plan. El consenso del plan ya está contado donde corresponde (Decisión).
        const board = stage.work || null;
        const value = board
          ? (board.total ? board.integrated / board.total : 0)
          : stage.measured ? (stage.global ?? 0) : null;
        const ok = value !== null && value >= threshold;
        return (
          <div key={stage.macro} className={`stageRow${stage.status === 'now' ? ' now' : ''}${stage.status === 'pending' ? ' pending' : ''}${stage.status === 'skipped' ? ' skipped' : ''}`}>
            <span className="stageName">
              {stage.status === 'now' && <i className="dot live" />}
              {stage.status === 'done' && <Icon name="check" size={11} strokeWidth={3} />}
              {stage.label}
            </span>
            <span className="stageBar">
              {value === null
                ? <em className="tiny">{stage.status === 'pending' ? 'aún no llega' : stage.status === 'skipped' ? 'no hubo' : 'sin puntos que medir'}</em>
                : <i className={ok ? 'ok' : ''} style={{ width: `${Math.round(value * 100)}%` }} />}
            </span>
            <span className="stageVal tiny">
              {board
                ? <>
                  <b>{board.integrated}/{board.total}</b>
                  <em> integradas</em>
                  {board.inProgress ? <em> · {board.inProgress} en curso</em> : null}
                </>
                : value === null
                  ? '—'
                  : <>
                    <b>{pct0(value)}</b>
                    {stage.total ? <em> · {stage.unresolved} sin cerrar</em> : null}
                  </>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Fases reales del protocolo (para la vista de sala).
export function PhaseLine({ room }: { room: Room }) {
  const order = MACRO_PHASES;
  const all = [...order.presentation, ...order.debate, ...order.synthesis, ...order.decision];
  const currentIdx = all.indexOf(room.phase);
  const optional: Phase[] = ['tiebreak', 'repair'];
  if (room.status === 'closed') {
    return (
      <div className="stepLine">
        <span className="phasePill done"><Icon name="check" size={12} strokeWidth={3} /> Resultado congelado</span>
      </div>
    );
  }
  return (
    <div className="stepLine">
      {all.map((phase, i) => {
        if (optional.includes(phase) && phase !== room.phase && !all.slice(0, currentIdx).includes(phase)) {
          return <span key={phase} className="phasePill opt">{PHASE_LABEL[phase]}</span>;
        }
        const state = i < currentIdx ? 'done' : i === currentIdx ? 'now' : '';
        return (
          <span key={phase} className={`phasePill ${state}`}>
            {state === 'done' && <Icon name="check" size={11} strokeWidth={3} />}
            {PHASE_LABEL[phase]}
          </span>
        );
      })}
    </div>
  );
}

export function MacroStepper({ room }: { room: Room }) {
  const currentIndex = MACRO_ORDER.indexOf(room.macro);
  const done = room.status === 'closed';
  return (
    <div className="stepper">
      {MACRO_ORDER.map((macro, i) => {
        const isDone = done || i < currentIndex;
        const isNow = !done && i === currentIndex;
        const running = room.status !== 'closed' && MACRO_PHASES[macro].includes(room.phase);
        return (
          <div key={macro} className={`step${isDone ? ' done' : isNow ? ' now' : ''}`}>
            <span className="n">{isDone ? <Icon name="check" size={11} strokeWidth={3} /> : i + 1}</span>
            <span>
              {MACRO_LABEL[macro]}
              <small>{isDone ? 'Completada' : running ? PHASE_LABEL[room.phase] : isNow ? 'En curso' : 'Pendiente'}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}
