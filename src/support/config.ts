/**
 * Where riders can support the project. Fill in the addresses of your own
 * accounts; a link left empty is not shown, and with none set the Support
 * card does not appear at all.
 *
 * Donations must stay voluntary: nothing in the app may be locked behind
 * them. That keeps this clear of app-store payment rules and of selling a
 * product that talks to someone else's hardware.
 */
export interface SupportLink {
  id: 'kofi' | 'githubSponsors' | 'buyMeACoffee' | 'paypal';
  /** Brand name; not translated. */
  label: string;
  url: string;
}

export const SUPPORT_LINKS: readonly SupportLink[] = [
  { id: 'kofi', label: 'Ko-fi', url: '' },
  { id: 'githubSponsors', label: 'GitHub Sponsors', url: '' },
  { id: 'buyMeACoffee', label: 'Buy Me a Coffee', url: '' },
  { id: 'paypal', label: 'PayPal', url: '' },
];

/** Public page of the source code. Empty while the repository is private. */
export const SOURCE_URL = '';

export function activeSupportLinks(links: readonly SupportLink[] = SUPPORT_LINKS): SupportLink[] {
  return links.filter((link) => /^https:\/\/\S+$/.test(link.url));
}
