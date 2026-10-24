const javascriptLike = Object.freeze({
    imports: String.raw`
(import_statement) @import.declaration
(call_expression
  function: (identifier) @import.function
  arguments: (arguments (string) @import.source)
  (#eq? @import.function "require")) @import.require
`,
    calls: String.raw`(call_expression) @call.expression`,
    writes: String.raw`(assignment_expression) @write.assignment`,
    boundaries: String.raw`
(program) @boundary.file
(class_declaration) @boundary.class
(function_declaration) @boundary.function
(method_definition) @boundary.method
`,
})

const cLike = Object.freeze({
    imports: String.raw`(preproc_include) @import.declaration`,
    calls: String.raw`(call_expression) @call.expression`,
    writes: String.raw`(assignment_expression) @write.assignment`,
    boundaries: String.raw`
(translation_unit) @boundary.file
(struct_specifier) @boundary.type
(function_definition) @boundary.function
`,
})

export const factQueries = Object.freeze({
    c: cLike,
    cpp: Object.freeze({
        ...cLike,
        boundaries: String.raw`
(translation_unit) @boundary.file
(namespace_definition) @boundary.module
(class_specifier) @boundary.type
(struct_specifier) @boundary.type
(function_definition) @boundary.function
`,
    }),
    c_sharp: Object.freeze({
        imports: String.raw`(using_directive) @import.declaration`,
        calls: String.raw`(invocation_expression) @call.expression`,
        writes: String.raw`(assignment_expression) @write.assignment`,
        boundaries: String.raw`
(compilation_unit) @boundary.file
(namespace_declaration) @boundary.module
(class_declaration) @boundary.type
(method_declaration) @boundary.function
`,
    }),
    go: Object.freeze({
        imports: String.raw`(import_spec) @import.declaration`,
        calls: String.raw`(call_expression) @call.expression`,
        writes: String.raw`(assignment_statement) @write.assignment`,
        boundaries: String.raw`
(source_file) @boundary.file
(type_declaration) @boundary.type
(function_declaration) @boundary.function
(method_declaration) @boundary.function
`,
    }),
    java: Object.freeze({
        imports: String.raw`(import_declaration) @import.declaration`,
        calls: String.raw`(method_invocation) @call.expression`,
        writes: String.raw`(assignment_expression) @write.assignment`,
        boundaries: String.raw`
(program) @boundary.file
(package_declaration) @boundary.module
(class_declaration) @boundary.type
(method_declaration) @boundary.function
`,
    }),
    javascript: javascriptLike,
    kotlin: Object.freeze({
        imports: String.raw`(import_header) @import.declaration`,
        calls: String.raw`(call_expression) @call.expression`,
        writes: String.raw`(assignment) @write.assignment`,
        boundaries: String.raw`
(source_file) @boundary.file
(class_declaration) @boundary.type
(function_declaration) @boundary.function
`,
    }),
    php: Object.freeze({
        imports: String.raw`(namespace_use_declaration) @import.declaration`,
        calls: String.raw`
[
  (function_call_expression)
  (scoped_call_expression)
] @call.expression
`,
        writes: String.raw`(assignment_expression) @write.assignment`,
        boundaries: String.raw`
(program) @boundary.file
(namespace_definition) @boundary.module
(class_declaration) @boundary.type
(function_definition) @boundary.function
(method_declaration) @boundary.function
`,
    }),
    python: Object.freeze({
        imports: String.raw`
[
  (import_statement)
  (import_from_statement)
] @import.declaration
`,
        calls: String.raw`(call) @call.expression`,
        writes: String.raw`(assignment) @write.assignment`,
        boundaries: String.raw`
(module) @boundary.file
(class_definition) @boundary.type
(function_definition) @boundary.function
`,
    }),
    ruby: Object.freeze({
        imports: String.raw`
(call
  method: (identifier) @import.function
  arguments: (argument_list (string) @import.source)
  (#eq? @import.function "require")) @import.require
`,
        calls: String.raw`(call) @call.expression`,
        writes: String.raw`(assignment) @write.assignment`,
        boundaries: String.raw`
(program) @boundary.file
(module) @boundary.module
(class) @boundary.type
(method) @boundary.function
`,
    }),
    rust: Object.freeze({
        imports: String.raw`(use_declaration) @import.declaration`,
        calls: String.raw`(call_expression) @call.expression`,
        writes: String.raw`(assignment_expression) @write.assignment`,
        boundaries: String.raw`
(source_file) @boundary.file
(struct_item) @boundary.type
(impl_item) @boundary.implementation
(function_item) @boundary.function
`,
    }),
    swift: Object.freeze({
        imports: String.raw`(import_declaration) @import.declaration`,
        calls: String.raw`(call_expression) @call.expression`,
        writes: String.raw`(assignment) @write.assignment`,
        boundaries: String.raw`
(source_file) @boundary.file
(class_declaration) @boundary.type
(protocol_declaration) @boundary.type
(function_declaration) @boundary.function
`,
    }),
    tsx: javascriptLike,
    typescript: javascriptLike,
})
