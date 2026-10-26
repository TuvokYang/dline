# Dline Testing Platform

A CLI testing framework for Dline's retained standalone integration surface, providing gRPC clients and utilities for automated scenarios.

## Overview

The platform enables integration validation of Dline's standalone contracts through:

- **gRPC Adapters** – clients for Dline's generated gRPC services
- **Test Harness** – runner, utilities, and type definitions
- **Spec Files** – JSON instructions for automated test cases

## Structure

```
testing-platform/
├── adapters/           # gRPC communication adapters
│   ├── grpcAdapter.ts     # Main gRPC adapter implementation
├── harness/            # Test execution support
│   ├── config.ts          # Non-deterministic response fields
│   ├── types.ts           # Spec type definitions
│   └── utils.ts           # Loading, comparison, and retry utilities
└── index.ts            # CLI entry point and spec runner
```

## Prerequisites

- **Node.js** ≥ 18 and **npm** ≥ 8
- **Protocol Buffers** (used for gRPC)

Generate proto files in the Dline repository root:

```bash
npm run protos
```

## Setup

From the Dline repository root:

```bash
npm run install:all
npm run protos
```

Then install and build the testing platform:

```bash
cd testing-platform
npm install
npm run build
```

## Running Spec File Tests

Before running specs, start Dline's retained standalone core API test server:

```bash
npm run test:sca-server
```

Run a spec file or directory with:

```bash
npm run start:dev <spec-file-or-folder>
```
