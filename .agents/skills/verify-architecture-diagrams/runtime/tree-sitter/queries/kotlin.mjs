export default `
(class_declaration
  (type_identifier) @name.definition.class) @definition.class

(function_declaration
  (simple_identifier) @name.definition.function) @definition.function

(property_declaration
  (variable_declaration
    (simple_identifier) @name.definition.property)) @definition.property
`
