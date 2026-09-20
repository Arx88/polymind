// Resultado congelado: plan final, comprobaciones, disenso, consenso por punto,
// coste medido y checksum. Todo verificable.

import { Icon } from './Icons';
import { LongText } from './LongText';
import { Tag } from './Ui';
import { FrameAudit } from './FrameAudit';
import { DeliverySummary } from './DeliverySummary';
import { POINT_STATUS_CLASS, POINT_STATUS_LABEL, SEVERITY_LABEL, WORK_STATUS_LABEL, pct0, dateTime, plural } from '../lib/format';
import type { Room } from '../lib/types';

export function ResultCard({ room, compactHeader = false }: { room: Room; compactHeader?: boolean }) {
  const result = room.result;
  if (!result) return null;

  if (result.outcome !== 'decided' || !result.winner) {
    return (
      <div className="resultCard" style={{ borderColor: '#fecaca', background: 'var(--red-soft)' }}>
        <h3 style={{ color: 'var(--red)' }}><Icon name="info" size={18} /> El debate no produjo un plan</h3>
        <p className="muted" style={{ marginTop: 8 }}>{result.reason || 'Sin propuesta ganadora.'}</p>
        <div className="checksum">checksum <b>{result.checksum}</b></div>
      </div>
    );
  }

  return (
    <div className="resultCard">
      <DeliverySummary room={room} />
      {!compactHeader && <>
      <h3><Icon name="check" size={18} strokeWidth={3} /> Resultado congelado</h3>
      <div style={{ marginTop: 10 }}>
        <b style={{ fontSize: 16 }}>{result.winner.title}</b>
        <div className="tiny" style={{ marginTop: 4 }}>
          por {result.winner.author} · versión v{result.winner.version} · cerrado {dateTime(result.closedAt)} ·
          {' '}{result.stats.agents} agentes · {result.stats.durationMin} min
        </div>
      </div>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <Tag tone={result.consensus.global >= result.consensus.threshold ? 'green' : 'amber'}>
          consenso {pct0(result.consensus.global)}
        </Tag>
        <Tag tone="blue">{result.consensus.agreed} de {result.consensus.total} puntos acordados</Tag>
        <Tag tone="purple">{result.checks.length} comprobaciones</Tag>
        <Tag tone="grey">~{result.cost?.estTokens ?? 0} tokens</Tag>
        {result.verification?.selfVerified && <Tag tone="amber">autoverificado</Tag>}
        {result.verification?.repaired && <Tag tone="amber">reparado tras verificar</Tag>}
      </div>

      </>}
      <div className="row" style={{ marginTop: compactHeader ? 0 : 16, flexWrap: 'wrap' }}>
        <b className="resultSectionTitle" style={{ fontSize: 14 }}>
          <span className="sectionIcon"><Icon name="doc" size={21} /></span>
          {result.finalSource === 'synthesis' ? `Plan final (síntesis de ${result.synthesisBy || '—'})` : 'Plan ganador'}
        </b>
        <span className="spacer" />
        <a className="linkBtn" href={`/api/rooms/${room.code}/export.md`} target="_blank" rel="noreferrer">
          <Icon name="download" size={15} /> Exportar markdown
        </a>
      </div>
      <LongText className="final" text={result.final} lines={12} label="el plan final" />

      {result.checks.length > 0 && (
        <>
          <b className="resultSectionTitle"><span className="sectionIcon"><Icon name="target" size={20} /></span>Comprobaciones propuestas</b>
          <p className="tiny">Criterios formulados por los agentes. No equivalen a pruebas ejecutadas por el servidor.</p>
          <div style={{ marginTop: 6 }}>
            {result.checks.map(check => (
              <div className="checkItem proposedCheck" key={check.id}>
                <span className="ic"><Icon name="target" size={15} /></span>
                <div>
                  <b>{check.claim}</b>
                  <div className="tiny">Comprobar: {check.method || '—'} · Esperado: {check.expectation || '—'} · por {check.by}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <details className="deliveryDetails">
      <summary>Decisiones, disenso y trazabilidad <span>{result.consensus.points.length} puntos · {result.dissent.length} objeciones registradas</span></summary>
      {!!result.collaboration?.length && <section className="collaborationDelivery">
        <h3>Ideas construidas entre agentes</h3>
        <p className="tiny">Aportes con autor y decisión explícita. Adoptar una idea es una declaración de la síntesis, no una medición de mejora.</p>
        {result.collaboration.map(idea => <div className="sharedImprovement" key={idea.id}>
          <div className="row wrap"><b>{idea.by}</b><Tag tone={idea.finalResponse?.disposition === 'declined' ? 'grey' : idea.finalResponse ? 'blue' : 'amber'}>{!idea.finalResponse ? 'Sin resolución final' : idea.finalResponse.disposition === 'adopted' ? 'Incorporada al plan' : idea.finalResponse.disposition === 'adapted' ? 'Adaptada al plan' : 'Descartada con motivo'}</Tag></div>
          <p>{idea.change}</p>
          {idea.finalResponse && <small>{idea.finalResponse.reason}</small>}
          {idea.validation && <small>Validación propuesta: {idea.validation}</small>}
        </div>)}
      </section>}
      {result.consensus.points.length > 0 && (
        <>
          <b className="resultSectionTitle"><span className="sectionIcon"><Icon name="target" size={20} /></span>Puntos de decisión</b>
          <div style={{ marginTop: 6 }}>
            {result.consensus.points.map(point => (
              <div className="agentRow" key={point.id}>
                <div className="who">
                  <b>{point.label}</b>
                  <small>{point.modal ? `mayoritaria: ${point.modal.label} (${pct0(point.share)})` : 'sin posición'}</small>
                </div>
                <span className={`stChip ${POINT_STATUS_CLASS[point.status]}`}>{POINT_STATUS_LABEL[point.status]}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {result.verification?.findings?.length ? (
        <>
          <b style={{ fontSize: 14, display: 'block', marginTop: 18 }}>Hallazgos de la verificación</b>
          {result.verification.findings.map((finding, i) => (
            <div className="agentRow" key={i}>
              <Tag tone={finding.severity === 'high' ? 'red' : 'amber'}>{SEVERITY_LABEL[finding.severity] || finding.severity}</Tag>
              <div className="who"><small style={{ whiteSpace: 'normal' }}>{finding.text}</small></div>
            </div>
          ))}
        </>
      ) : null}

      {result.dissentProtection?.measured && (
        <>
          <div className="row wrap" style={{ marginTop: 18 }}>
            <b style={{ fontSize: 14 }}>Disenso protegido</b>
            <span className="spacer" />
            <Tag tone={result.dissentProtection.contestedCount ? 'amber' : 'grey'}>
              {result.dissentProtection.contestedCount
                ? plural(result.dissentProtection.contestedCount, 'punto disputado', 'puntos disputados')
                : 'ningún punto quedó disputado'}
            </Tag>
            <Tag tone="grey">unanimidad {pct0(result.dissentProtection.unanimity)}</Tag>
            {result.dissentProtection.convergenceWithoutEvidence.count > 0 && (
              <Tag tone="amber">
                {plural(result.dissentProtection.convergenceWithoutEvidence.count,
                  'posición movida sin evidencia', 'posiciones movidas sin evidencia')}
              </Tag>
            )}
            {result.dissentProtection.vote.collapsed && (
              <Tag tone="amber">votación entre propuestas {pct0(result.dissentProtection.vote.maxSimilarity)} idénticas</Tag>
            )}
          </div>
          <p className="tiny" style={{ marginTop: 8 }}>
            La unanimidad es la cuota de puntos votados donde todos eligieron lo mismo. Un disenso protegido
            alto, con nombres, dice más que un consenso perfecto: nadie sostuvo la otra mitad.
          </p>
          {result.dissentProtection.byAuthority.length > 0 && (
            <p className="tiny" style={{ marginTop: 8 }}>
              <b>Resuelto por autoridad de síntesis, sin dato nuevo:</b> {result.dissentProtection.byAuthority.join(', ')}.
            </p>
          )}
          {result.dissentProtection.unresolved.length > 0 && (
            <p className="tiny" style={{ marginTop: 8 }}>
              <b>Sin resolver en la síntesis:</b> {result.dissentProtection.unresolved.map(u => u.label).join(', ')}.
              Un punto abierto que no se menciona tampoco queda cerrado.
            </p>
          )}
          {result.dissentProtection.resolutions.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {result.dissentProtection.resolutions.map(res => (
                <div className="agentRow" key={res.pointId}>
                  <div className="who">
                    <b>{res.pointLabel}</b>
                    <small style={{ whiteSpace: 'normal' }}>
                      {res.choiceLabel || res.choiceId || 'sin opción fijada'}
                      {res.evidence ? ` · ${res.evidence}` : ''}
                    </small>
                  </div>
                  <Tag tone={res.basis === 'authority' ? 'amber' : res.basis === 'adopted-dissent' ? 'blue' : 'green'}>
                    {res.basis === 'authority' ? 'por autoridad' : res.basis === 'adopted-dissent' ? 'adoptó la minoría' : 'con evidencia'}
                  </Tag>
                </div>
              ))}
            </div>
          )}
          {result.dissentProtection.convergenceWithoutEvidence.moves.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="tiny">
                Movimientos de posición ({result.dissentProtection.convergenceWithoutEvidence.total} ·
                {' '}{result.dissentProtection.convergenceWithoutEvidence.count} sin evidencia)
              </summary>
              {result.dissentProtection.convergenceWithoutEvidence.moves.map((move, i) => (
                <div className="tiny" key={i} style={{ marginTop: 6 }}>
                  <b style={{ color: 'var(--ink)' }}>{move.by}</b> en «{move.point}»: {move.from} → {move.to}
                  {move.because ? ` — ${move.because}` : ' — sin citar qué lo movió'}
                </div>
              ))}
            </details>
          )}
        </>
      )}

      {/* El encuadre también se audita: un solo número de consenso puede esconder disenso, y
          el primer eje puede haber ordenado todo el debate sin que nadie lo dijera. */}
      <FrameAudit audit={result.agendaReview} flat />

      {result.dissent.length > 0 && (
        <>
          <b style={{ fontSize: 14, display: 'block', marginTop: 18 }}>Objeciones y minorías registradas ({result.dissent.length})</b>
          {result.dissent.map((item, i) => (
            <div className="agentRow" key={i}>
              <div className="who">
                <b>{item.by}</b>
                <small style={{ whiteSpace: 'normal' }}>{item.text}</small>
              </div>
              <Tag tone={item.addressed ? 'green' : item.severity === 'blocker' ? 'red' : 'amber'}>
                {item.addressed ? 'atendido' : (SEVERITY_LABEL[item.severity] || item.severity)}
              </Tag>
            </div>
          ))}
        </>
      )}

      {result.ruleChanges.length > 0 && (
        <>
          <b style={{ fontSize: 14, display: 'block', marginTop: 18 }}>Reglas ratificadas durante el debate</b>
          {result.ruleChanges.map((change, i) => (
            <div className="agentRow" key={i}>
              <div className="who"><small style={{ whiteSpace: 'normal' }}>{change.text} — propuesto por {change.by}</small></div>
            </div>
          ))}
        </>
      )}

      {result.scoreboard?.byAgent?.length ? (
        <>
          <b style={{ fontSize: 14, display: 'block', marginTop: 18 }}>Marcador por harness</b>
          <p className="tiny" style={{ marginTop: 4 }}>
            Quién hizo qué, contado del registro: <b>apoyó la elegida</b> es haber puesto al ganador primero en el voto secreto,
            <b> disintió</b> es haber sostenido una opción distinta de la mayoritaria y <b>cambió de opinión</b> es haber
            publicado una versión nueva después de la crítica. Apoyar a la ganadora no demuestra que la decisión sea correcta.
          </p>
          <div className="stack" style={{ marginTop: 8, gap: 0 }}>
            {result.scoreboard.byAgent.map(row => (
              <div className="scoreRow" key={row.id}>
                <div className="who">
                  <b>{row.name}</b>
                  <small>
                    {row.harness || 'harness sin declarar'}{row.model ? ` · ${row.model}` : ''}
                    {row.status === 'absent' ? ' · ausente' : ''}
                  </small>
                </div>
                <span className="spacer" />
                <div className="scoreTags">
                  {row.votedWinner && <Tag tone="grey">apoyó la elegida</Tag>}
                  {row.wonProposal && <Tag tone="green">ganó</Tag>}
                  {row.dissentPoints > 0 && <Tag tone="amber">disintió {row.dissentPoints}</Tag>}
                  {row.agreedPoints > 0 && <Tag tone="grey">acordó {row.agreedPoints}</Tag>}
                  {row.revised > 0 && <Tag tone="blue">cambió de opinión {row.revised}</Tag>}
                  {row.conceded > 0 && <Tag tone="grey">retiró {row.conceded}</Tag>}
                  {row.blockers > 0 && <Tag tone="red">vetó {row.blockers}</Tag>}
                  {row.findings > 0 && <Tag tone="purple">hallazgos {row.findings}{row.corroboratedFindings ? ` (${row.corroboratedFindings} corroborado)` : ''}</Tag>}
                  {row.patches > 0 && <Tag tone="green">parches {row.patches}</Tag>}
                  {row.reviews > 0 && <Tag tone="blue">revisó {row.reviews}</Tag>}
                  {row.verifier && <Tag tone="purple">verificó</Tag>}
                  {row.integrated > 0 && <Tag tone="green">{plural(row.integrated, 'integrada')}</Tag>}
                  {row.reverted > 0 && <Tag tone="purple">{plural(row.reverted, 'deshecha')} después</Tag>}
                </div>
                <span className="tiny">{plural(row.moves, 'movimiento')} · ~{row.tokens} tok</span>
              </div>
            ))}
          </div>
          {result.scoreboard.highlights.length > 0 && (
            <div className="stack" style={{ marginTop: 10, gap: 2 }}>
              {result.scoreboard.highlights.map(h => (
                <span className="tiny" key={h.label}><b>{h.names.join(', ')}</b> — {h.label} ({h.value}).</span>
              ))}
            </div>
          )}
        </>
      ) : null}

      {result.work && (
        <>
          <b style={{ fontSize: 14, display: 'block', marginTop: 18 }}>Trabajo sobre el repositorio</b>
          <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
            <Tag tone="purple"><Icon name="branch" size={13} /> {result.work.branch}</Tag>
            <Tag tone="grey">base <span className="mono">{result.work.baseCommit.slice(0, 10)}</span></Tag>
            <Tag tone="green">{result.work.stats.integrated}/{result.work.stats.items} mejoras integradas</Tag>
            {result.work.stats.reverted > 0 && <Tag tone="purple">{plural(result.work.stats.reverted, 'deshecha')} por el humano</Tag>}
            <Tag tone="blue">diff {plural(result.work.stats.files, 'archivo')} +{result.work.stats.insertions}/-{result.work.stats.deletions}</Tag>
            {result.work.verifyCommand && <Tag tone="grey"><span className="mono">{result.work.verifyCommand}</span></Tag>}
            {result.work.baseline?.ran && (
              <Tag tone={result.work.baseline.ok ? 'green' : 'red'}>
                línea base {result.work.baseline.ok ? 'en verde' : 'en rojo'}
              </Tag>
            )}
            {result.work.stats.unreviewed > 0 && <Tag tone="amber">{result.work.stats.unreviewed} sin revisar</Tag>}
          </div>

          {result.work.items.map(item => (
            <div className="agentRow" key={item.id}>
              <Tag tone={item.status === 'integrated' ? 'green' : item.status === 'reverted' ? 'purple' : item.status === 'failed' ? 'red' : 'amber'}>
                {WORK_STATUS_LABEL[item.status] || item.status}
              </Tag>
              <div className="who">
                <b>{item.title}</b>
                <small style={{ whiteSpace: 'normal' }}>
                  {item.id}{item.files.length ? ` · ${item.files.join(', ')}` : ''}
                  {item.byName ? ` · parche de ${item.byName}` : ''}
                  {item.reviewerName ? `, revisado por ${item.reviewerName}` : item.unreviewed ? ' · sin revisión independiente' : ''}
                  {item.verify?.ran ? ` · verificación ${item.verify.ok ? 'en verde' : `en rojo (${item.verify.exitCode})`}` : ' · sin verificación ejecutable'}
                  {item.commit ? ` · commit ${item.commit.slice(0, 9)}` : ''}
                  {item.revert ? ` · deshecha después${item.revert.reason ? `: ${item.revert.reason}` : ''}` : ''}
                </small>
                {item.revert?.verify && (
                  <small style={{ whiteSpace: 'normal' }}>
                    Tras deshacerla, la verificación {item.revert.verify.status === 'running'
                      ? 'se está ejecutando ahora mismo'
                      : item.revert.verify.ran
                        ? (item.revert.verify.ok ? 'vuelve a pasar en verde' : `queda en rojo (código ${item.revert.verify.exitCode})`)
                        : 'no se pudo ejecutar'}.
                  </small>
                )}
              </div>
            </div>
          ))}

          <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
            <a className="linkBtn" href={`/api/rooms/${room.code}/work.diff`} target="_blank" rel="noreferrer">
              <Icon name="download" size={15} /> Diff de la rama
            </a>
            <a className="linkBtn" href={`/api/rooms/${room.code}/work.patch`} target="_blank" rel="noreferrer">
              <Icon name="download" size={15} /> Parche para git am
            </a>
          </div>
          <p className="tiny" style={{ marginTop: 8 }}>
            El trabajo vive en la rama <span className="mono">{result.work.branch}</span> del clon del servidor, nunca en tu
            repo: tráetelo con <span className="mono">git fetch &lt;ruta-del-clon&gt; {result.work.branch}</span>.
          </p>
          {result.work.undebated?.length > 0 && (
            <p className="tiny" style={{ marginTop: 8 }}>
              {plural(result.work.undebated.length, 'hallazgo')} de la auditoría no entraron en la agenda (sin hueco): quedan
              listados en el export markdown.
            </p>
          )}
        </>
      )}

      </details>
      <div className="checksum">
        checksum <b>{result.checksum}</b>
        <div style={{ marginTop: 4 }}>
          Cualquier agente puede verificar que vio exactamente esta versión del resultado.
        </div>
      </div>
    </div>
  );
}
