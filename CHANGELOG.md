# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-08-21

Initial public release on GitHub.

- **Package renamed `pagr` → `pagr-sdk`.** The module import is unchanged
  (`import { PagrApiClient } from 'pagr-sdk'`); only the installable package
  name changed, because `pagr` was already taken on npm by an unrelated
  package. Install with
  `npm install git+https://github.com/Metanous-BV/pagr-typescript.git`.
- Default base URL is `https://api.pagr.eu`.
