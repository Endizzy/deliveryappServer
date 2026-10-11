import test from "node:test";
import assert from "node:assert/strict";
import {
    NOTE_MAX_LEN,
    canUseNotes,
    canManageNote,
    isValidNotePhone,
    validateNoteText,
    rowToNoteDto,
} from "../customerNotesLogic.js";

test("роли: owner/admin да, courier нет", () => {
    assert.equal(canUseNotes("owner"), true);
    assert.equal(canUseNotes("admin"), true);
    assert.equal(canUseNotes("courier"), false);
    assert.equal(canUseNotes(undefined), false);
});

test("canManageNote: автор и владелец; чужой админ нет", () => {
    const note = { created_by: 5 };
    assert.equal(canManageNote({ role: "admin", userId: 5 }, note), true);
    assert.equal(canManageNote({ role: "admin", userId: "5" }, note), true);
    assert.equal(canManageNote({ role: "admin", userId: 6 }, note), false);
    assert.equal(canManageNote({ role: "owner", userId: 1 }, note), true);
    assert.equal(canManageNote({ role: "admin", userId: 6 }, { created_by: null }), false);
    assert.equal(canManageNote(null, note), false);
});

test("isValidNotePhone", () => {
    assert.equal(isValidNotePhone("+37120000000"), true);
    assert.equal(isValidNotePhone("20000000"), false);
    assert.equal(isValidNotePhone(""), false);
    assert.equal(isValidNotePhone("+371 200"), false);
});

test("validateNoteText: обрезка, пустое, длина", () => {
    assert.deepEqual(validateNoteText("  привет \r\n мир "), { ok: true, text: "привет \n мир" });
    assert.equal(validateNoteText("   ").ok, false);
    assert.equal(validateNoteText(null).ok, false);
    assert.equal(validateNoteText("a".repeat(NOTE_MAX_LEN)).ok, true);
    assert.equal(validateNoteText("a".repeat(NOTE_MAX_LEN + 1)).ok, false);
});

test("rowToNoteDto: не отдаёт created_by, считает done и canManage", () => {
    const dto = rowToNoteDto(
        { id: "7", note_text: "t", created_by: 1, created_by_name: "Центр", created_at: new Date("2026-10-10T10:00:00Z"), updated_at: null, done_at: null },
        { role: "admin", userId: 1 }
    );
    assert.equal(dto.id, 7);
    assert.equal(dto.done, false);
    assert.equal(dto.canManage, true);
    assert.equal(dto.createdAt, "2026-10-10T10:00:00.000Z");
    assert.equal("created_by" in dto, false);
});
