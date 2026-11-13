# Taking donations

The app is prepared for voluntary donations. Nothing is sold and nothing is locked: that is what keeps this simple.

## What is already in the app

- **Settings → Support MotoLink**: one button per donation link. The card stays hidden until at least one link is filled in.
- **Settings → About**: version, a statement that the project is independent of CFMOTO, Carbit, Apple and Google, and a riding-safety disclaimer. Translated into all five languages.

## ❗ What you need to do

1. ❗ **Open an account** on the platform you prefer. Ko-fi and Buy Me a Coffee take minutes and accept cards and PayPal. GitHub Sponsors needs approval and pays out without a fee.
2. ❗ **Put your links in** [src/support/config.ts](../src/support/config.ts). Only `https://` links are shown.
3. ❗ **GitHub button**: create `.github/FUNDING.yml` with your accounts, for example:

   ```yaml
   github: iamandiradu
   ko_fi: your_kofi_name
   ```

   GitHub then shows a Sponsor button on the repository. It only appears on a public repository.
4. ❗ **Choose a licence** before making the repository public. Without one, nobody may legally use or share the code. MIT is the permissive choice; GPL-3.0 or AGPL-3.0 require others to share their changes.
5. ❗ **Decide whether to make the repository public.** Donations depend on people finding the project. This step cannot be fully undone: once public, copies exist.

## Rules worth keeping

- **Voluntary only.** Do not unlock features for donors. A paid feature turns a donation into a sale, which brings app-store payment rules, consumer law and, here, the question of selling a product that presents itself to the dash as CFMOTO's own app.
- **No CFMOTO branding.** Say "works with" or "compatible with", never suggest it is theirs. Do not use their logo.
- **App Store.** If the app ever goes to Apple's App Store, donation links to outside payment pages are restricted there; the Support card would have to be removed or reworked for that build. Sideloaded and Android builds are not affected.
- **Tax.** Donations are income. Check how your country treats them.

## What is not done

- No donation links are set. The Support card is hidden until you add them.
- No licence file exists yet.
- The repository is private.
