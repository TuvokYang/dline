/**
 * Han, kana, CJK punctuation and full-width forms. Their presence outside code
 * in the English edition means untranslated text or a UI string that fell back
 * to the Chinese default locale.
 */
export const CJK_TEXT = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
