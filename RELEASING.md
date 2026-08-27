# Releasing Climate Schedule

## First publication

1. Create the public GitHub repository `matt-blackstone/ha-climate-schedule`
   without adding GitHub's starter README, license, or `.gitignore` files.
2. Set the repository description to **Seasonal weekly climate schedules for
   Home Assistant**.
3. Enable Issues and add these topics: `home-assistant`,
   `home-assistant-custom-component`, `hacs`, `climate`, and `scheduler`.
4. Add the remote and push the local `main` branch:

   ```bash
   git remote add origin git@github.com:matt-blackstone/ha-climate-schedule.git
   git push -u origin main
   ```

5. Wait for both GitHub Actions checks, **HACS** and **Hassfest**, to pass.
6. Create a GitHub release named `vX.Y.Z` from the matching `vX.Y.Z` tag.
7. In Home Assistant, add the public repository as a HACS **Integration**
   custom repository and verify install, setup, card loading, and an active
   schedule period.

## Later releases

1. Update `version` in `custom_components/climate_schedule/manifest.json`.
2. Update the README if the installation, configuration, or behavior changed.
3. Run the local checks below and test the UI environment.
4. Commit, push, and wait for the HACS and Hassfest actions to pass.
5. Create and publish a GitHub release with a matching `vX.Y.Z` tag.

```bash
git status --short
git diff --check
python3 -m json.tool hacs.json >/dev/null
python3 -m json.tool custom_components/climate_schedule/manifest.json >/dev/null
python3 -m json.tool custom_components/climate_schedule/translations/en.json >/dev/null
git tag -a vX.Y.Z -m "Climate Schedule vX.Y.Z"
git push --follow-tags
```

## HACS distribution paths

- **Custom repository:** available as soon as the GitHub repository is public.
  HACS can install the default branch before the first release, although a
  published release is recommended for predictable upgrades.
- **Default HACS catalogue:** optional and separate. It requires a public
  GitHub repository, a GitHub release, successful HACS and Hassfest actions,
  appropriate Home Assistant brand assets, and an accepted pull request to
  `hacs/default`. Review time can be substantial; users do not need to wait for
  it to install the integration as a custom repository.
