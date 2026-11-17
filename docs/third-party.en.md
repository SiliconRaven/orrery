# Third-Party Notices & Asset Provenance

Language: [中文](third-party.md) | **English**

orrery source code is released under the **MIT License** (the authoritative English legal text is maintained in the root `LICENSE` file without translation substitution). The project's MIT license covers orrery's own code only and **does not automatically re-license third-party dependencies, external applications, or bundled visual assets**.

## Software Dependencies & Upstream References

- **Runtime and dev dependencies**: Third-party packages referenced by the root project and `desktop/` subpackage (such as `@modelcontextprotocol/sdk`, `zod`, Electron, `koffi`, and Knip) remain governed by their respective licenses.
- **Upstream reference attribution**: The permission and process-isolation model in [External Plugin Protocol](external-plugins.en.md) acknowledges the MIT-licensed `deepseek-harness` (`dsh-v0.2.1-rc.2`) reference under its upstream terms.

## Icons & Visual Assets

1. **9 Third-Party Application Icons**: The 9 application icons displayed in the UI and member list are included solely to identify the corresponding host apps; all trademarks and icon rights remain with their respective owners and are outside the project's MIT license.
2. **Project icon**: The single-orbit icon is defined by the original SVG sources in `desktop/assets/orrery-icon.svg` and `orrery-mark.svg`. Its PNG and Windows ICO exports are generated from those sources and are included under the project MIT license. No character illustrations are bundled.
