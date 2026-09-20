// Iconos en línea: sin librerías y con el mismo trazo que el resto de la interfaz.

export type IconName =
  | 'plus' | 'chat' | 'users' | 'doc' | 'chart' | 'gear' | 'arrow' | 'check'
  | 'sparkle' | 'layers' | 'rocket' | 'code' | 'coins' | 'scale' | 'back'
  | 'copy' | 'info' | 'shield' | 'bolt' | 'target' | 'bulb' | 'flag' | 'play'
  | 'download' | 'link' | 'refresh' | 'stop' | 'clock' | 'robot' | 'branch' | 'undo'
  | 'search';

const PATHS: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.5 0-3-.4-4.2-1L3 20l1.3-4.9a8 8 0 0 1-1.3-4.4A8.4 8.4 0 0 1 11.5 3.2 8.4 8.4 0 0 1 21 11.5Z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5M9 13h6M9 17h4',
  chart: 'M4 19h16M7 16V9m5 7V5m5 11v-5',
  gear: 'M9.5 3h5l.5 3 2 1 2.8-1 2.5 4.3-2.3 2v2.4l2.3 2-2.5 4.3-2.8-1-2 1-.5 3h-5l-.5-3-2-1-2.8 1L1.7 16.7l2.3-2v-2.4l-2.3-2L4.2 6 7 7l2-1 .5-3ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M20 6 9 17l-5-5',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9ZM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z',
  layers: 'M12 3 3 8l9 5 9-5Zm0 18 9-5-3-1.7M3 16l9 5 3-1.7',
  rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 14l-1-4 6-6c3 0 5 2 5 5l-6 6Zm4-3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  code: 'm8 8-4 4 4 4m8-8 4 4-4 4M14 4l-4 16',
  coins: 'M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8Zm8-2.5v13c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5v-13M20 12c0 1.4-3.6 2.5-8 2.5S4 13.4 4 12',
  scale: 'M12 3v18M7 21h10M4 7h16M5 7l-4 8h8L5 7Zm14 0-4 8h8l-4-8Z',
  back: 'M15 6l-6 6 6 6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13h.01M11 12h1v5h1',
  shield: 'M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6ZM9 12l2 2 4-4',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6Z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v4h6v-4a6 6 0 0 0-3-11Z',
  flag: 'M5 21V4m0 0 8 2 4-1v9l-4 1-8-2',
  play: 'M7 4l12 8-12 8Z',
  download: 'M12 4v12m0 0 4-4m-4 4-4-4M5 20h14',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  stop: 'M7 7h10v10H7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  robot: 'M8 8V6a4 4 0 0 1 8 0v2M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm3 5h.01M15 13h.01M9 17h6',
  branch: 'M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0v3a3 3 0 0 1-3 3H9',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4',
  search: 'm21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
};

export function Icon({ name, size = 18, className, strokeWidth = 1.8 }: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function LogoMark({ size = 40 }: { size?: number }) {
  return <svg className="mark" width={size} height={size} viewBox="0 0 48 40" aria-hidden="true">
    <path d="M2 2C15 2 15 15 24 18C13 20 11 10 2 12Z" fill="#35ceef" />
    <path d="M2 15C12 13 15 20 24 20C14 23 12 27 2 26Z" fill="#3989ff" />
    <path d="M2 29C14 30 17 22 24 22C16 27 15 38 2 38Z" fill="#8148ff" />
    <path d="M46 2C33 2 33 15 24 18C35 20 37 10 46 12Z" fill="#ff7e82" />
    <path d="M46 15C36 13 33 20 24 20C34 23 36 27 46 26Z" fill="#ef6aad" />
    <path d="M46 29C34 30 31 22 24 22C32 27 33 38 46 38Z" fill="#dc46df" />
  </svg>;
}
