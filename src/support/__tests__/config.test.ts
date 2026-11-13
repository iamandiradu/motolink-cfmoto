import { SUPPORT_LINKS, activeSupportLinks } from '../config';

describe('support links', () => {
  it('shows only links that are filled in with an https address', () => {
    const links = [
      { id: 'kofi' as const, label: 'Ko-fi', url: 'https://ko-fi.com/someone' },
      { id: 'paypal' as const, label: 'PayPal', url: '' },
      { id: 'buyMeACoffee' as const, label: 'Buy Me a Coffee', url: 'http://insecure.example' },
      { id: 'githubSponsors' as const, label: 'GitHub Sponsors', url: 'javascript:alert(1)' },
    ];
    expect(activeSupportLinks(links).map((link) => link.id)).toEqual(['kofi']);
  });

  it('ships with no links until the owner adds their accounts', () => {
    expect(activeSupportLinks(SUPPORT_LINKS)).toEqual([]);
  });
});
