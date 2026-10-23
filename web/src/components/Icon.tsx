import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'grid'
  | 'history'
  | 'settings'
  | 'back'
  | 'refresh'
  | 'search'
  | 'play'
  | 'edit'
  | 'upload'
  | 'shuffle'
  | 'close'
  | 'chevron'
  | 'plus'
  | 'image'
  | 'video'
  | 'download'
  | 'share'
  | 'copy'
  | 'check'
  | 'alert'
  | 'link'
  | 'trash'
  | 'arrow-up'
  | 'arrow-down'
  | 'spark';

const paths: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-1.9 1.9-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.68v-.08a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.9-1.9.06-.06A1.7 1.7 0 0 0 7.7 15a1.7 1.7 0 0 0-1.56-1.03H6v-2.68h.08A1.7 1.7 0 0 0 7.64 10.2a1.7 1.7 0 0 0-.34-1.87L7.24 8.27l1.9-1.9.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1.03-1.56V5h2.68v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06 1.9 1.9-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.03H20v2.68h-.08A1.7 1.7 0 0 0 18.36 15Z" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.2 6.3" />
      <path d="M20 4v7h-7" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />,
  edit: (
    <>
      <path d="M4 20h4l10.3-10.3a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  shuffle: (
    <>
      <path d="M3 7h3.5c1.6 0 3.1.8 4 2.1l3 4.4a4.8 4.8 0 0 0 4 2.1H21" />
      <path d="M18 4l3 3-3 3" />
      <path d="M3 17h3.5c1.6 0 3.1-.8 4-2.1" />
      <path d="M14.5 9.1a4.8 4.8 0 0 1 4-2.1H21" />
      <path d="M18 12l3 3-3 3" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-5 5-2-2-6 6" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5" width="13" height="14" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 11.5L12 16l4.5-4.5" />
      <path d="M5 20h14" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8l7.6-4.3" />
      <path d="M8.2 13.2l7.6 4.3" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 3l9.5 17h-19z" />
      <path d="M12 9v5" />
      <path d="M12 17h.01" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11 6.3" />
      <path d="M14 11a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.8-1.8" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  spark: (
    <>
      <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7z" />
      <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" />
    </>
  ),
};

export function Icon({
  name,
  size = 22,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
