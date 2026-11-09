---
name: changing-protobuf-contracts
description: Evolve Dline Proto fields and RPCs, regenerate their projections, connect handlers and clients, and preserve presence and enum identity through conversions and consumers.
---

# Develop Protobuf Contracts and RPCs

Use this skill for a field/message/RPC change or missing generated wiring. `engineering-guide` owns protocol architecture and compatibility rules; `storage` owns persistent-state projections.

## Locate the Source and a Working Method

| Contract | Source |
|---|---|
| Application and Webview services | `proto/dline/*.proto` |
| Provider/model messages | `proto/dline/models.proto` and `proto/dline/provider/` |
| IDE host services | `proto/dline/host/*.proto` |
| Shared messages | `proto/dline/common.proto` |

Follow a method in the same service through its generated registration, handler, conversion and client. Use dline package namespaces and dline-rooted imports. Existing conventions are PascalCaseService for services, camelCase RPCs, PascalCase messages/enums and snake_case fields.

## Carry Optional Presence Through the Application

Illustrative proto3 schema:

```protobuf
syntax = "proto3";
package dline.example;

message ReadDocumentRequest {
  string document_id = 1;
  optional bool include_archived = 2;
}

message ReadDocumentResponse {
  string text = 1;
}

service DocumentService {
  rpc readDocument(ReadDocumentRequest) returns (ReadDocumentResponse);
}
```

If omission inherits a setting while false overrides it, preserve all three inputs—omitted, false and true—in the DTO conversion and downstream setting read. A conversion such as `value ?? false` would merge omission with an explicit false. Trace that distinction through validation, persistence, Controller projection and the control's initial value.

For an approved removal of document_id, evolve the schema as:

```protobuf
message ReadDocumentRequest {
  reserved 1;
  reserved "document_id";
  optional bool include_archived = 2;
  string resource_key = 3;
}
```

This keeps old field 1 from being decoded as an unrelated new value. Unchanged meanings retain their existing field numbers. For persisted/UI enums, inspect both directions in `src/shared/proto-conversions/` and the consumer's old/unknown-value handling.

## Generate the Projections

The repository-root command is:

```text
npm run protos
```

`package.json` and `scripts/build-proto.mjs` own generation. Outputs include:

- `src/shared/proto/`: message types and Dline barrels;
- `src/generated/grpc-js/`: service definitions;
- `src/generated/nice-grpc/`: promise clients;
- `src/generated/hosts/`: ProtoBus and host-bridge glue;
- `webview-ui/src/services/grpc-client.ts`: Webview clients;
- `dist-standalone/proto/descriptor_set.pb`: retained standalone descriptor.

For generated Settings/Secrets fields, edit `src/shared/storage/state-keys.ts`, run `node scripts/generate-state-proto.mjs`, then `npm run protos`. Inspect the generated methods and imports. The postprotos hook also formats controller, host and client directories; account for those outputs when reading the diff.

## Connect the Method to Its Consumer

Application handlers live under `src/core/controller/<domain>/`; IDE host handlers under `src/hosts/vscode/hostbridge/<service>/`. Generated registries use service/method names to connect them. Match the new method to its generated registration and implement DTO-to-domain validation/conversion in the owning handler.

The Webview calls the generated client from `webview-ui/src/services/grpc-client.ts` and imports message types from `@shared/proto/dline/...`. Core/standalone and host adapters use their corresponding generated client. For the example readDocument RPC, trace a caller's request into the registered handler and its returned domain value/error back into the response.

For a missing field, follow it through normalization, both conversions, persistence, initial projection and later UI/CLI updates. For a streaming RPC, follow the subscription's abort/disposal through the handler's owned resources.

## Exercise the Changed Round Trip

Use the handler/conversion/codec tests with omitted, explicit and old payload values. For the optional example, save/reopen through the actual setting consumer where persistence is involved; creating a generated message and reading it immediately exercises only the message object.

```text
npm run check-types
npm run lint
git diff --check
```

check-types includes Protobuf generation. Load `use-vitest` for focused test execution; `use-e2e` and `e2e-validation` cover real Webview/host integration when that is the changed boundary.
