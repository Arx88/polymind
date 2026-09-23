import { Avatar } from './Avatar';
import { LogoMark } from './Icons';

export interface ArtSeat { label: string; harness?: string | null; active?: boolean }

// The room illustration is populated only by actual participants, never demo agents.
export function RoomArt({ seats = [], height = 260, blocked = false }: { seats?: ArtSeat[]; height?: number; blocked?: boolean }) {
  return <div className="polymindStudio" style={{ minHeight: height }}>
    <div className="studioCaption"><LogoMark size={32} /><span>Distintas mentes.<br /><b>Un trabajo compartido.</b></span></div>
    {seats.length ? <div className="studioMembers">
      {seats.map((seat, index) => <div className="studioMember" key={`${seat.label}-${index}`}>
        <Avatar name={seat.label} harness={seat.harness} size={76} dim={seat.active === false} />
        <b>{seat.label}</b><small>{seat.harness || 'Harness sin declarar'}</small>
      </div>)}
    </div> : <div className="studioEmpty"><img src="/images/polymind-minds.png" alt="Personajes de Polymind" /><span>{blocked ? <>Falta preparar el proyecto.<br /><b>Reintenta antes de conectar harnesses.</b></> : <>El espacio está listo.<br /><b>Conecta tu primer harness.</b></>}</span></div>}
  </div>;
}
export function seatsFromRoom(roster: { name: string; harness?: string | null; status?: string }[]): ArtSeat[] {
  return roster.map(agent => ({ label: agent.name, harness: agent.harness, active: agent.status !== 'absent' }));
}
export const ART_DEFAULT_SEATS: ArtSeat[] = [];
