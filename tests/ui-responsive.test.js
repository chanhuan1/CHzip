"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const css = fs.readFileSync(
    path.join(__dirname, "../app/www/css/style.css"),
    "utf8",
);
const html = fs.readFileSync(
    path.join(__dirname, "../app/www/index.html"),
    "utf8",
);

function declarations(property) {
    return [...css.matchAll(new RegExp(`${property}:\\s*([^;]+);`, "g"))]
        .map((match) => match[1].trim());
}

test("action bar precedes the workspace and mobile job layout is explicit", () => {
    assert.ok(html.indexOf('class="job-bar"') < html.indexOf('class="work-grid"'));
    const jobBar = html.slice(
        html.indexOf('class="job-bar"'),
        html.indexOf('class="work-grid"'),
    );
    assert.match(jobBar, /id="deleteSourceInput"/);
    assert.doesNotMatch(
        html.slice(html.indexOf('class="settings-panel"')),
        /id="deleteSourceInput"/,
    );
    assert.ok(declarations("position").includes("fixed"));
    assert.match(css, /env\(safe-area-inset-bottom/);
});

test("touch preview and primary controls keep at least 44px targets", () => {
    assert.ok(declarations("opacity").includes("1"));
    assert.ok(declarations("min-height").includes("44px"));
    assert.ok(declarations("width").includes("44px"));
});

test("mobile dialogs are viewport-bound and password empty state is not tall", () => {
    assert.match(css, /max-height:\s*calc\(100dvh - 24px/);
    assert.ok(declarations("min-height").includes("0"));
    assert.ok(declarations("align-items").includes("flex-end"));
});

test("smallest view uses compact icon-only view toggles", () => {
    assert.match(css, /@media \(max-width: 380px\)/);
    assert.match(css, /\.view-switch-btn span\s*\{\s*display:\s*none/);
});

test("responsive refinements respect reduced motion", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.preview-backdrop,\s*\n\s*\.preview-dialog,/);
});

test("final mobile preview override stays after base preview rules", () => {
    const tail = css.slice(css.lastIndexOf("@media (max-width: 680px)"));
    assert.match(tail, /\.preview-backdrop\s*\{[\s\S]*align-items:\s*flex-end/);
    assert.match(tail, /\.preview-dialog\s*\{[\s\S]*width:\s*100%/);
    assert.match(css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)")),
        /button:not\(:disabled\)\s*\{\s*transition:\s*none/);
});

test("delete-source option keeps the task-bar surface and uses blue for selection", () => {
    const baseStart = css.indexOf(".job-option {");
    const baseEnd = css.indexOf(".job-option input {");
    assert.ok(baseStart >= 0 && baseEnd > baseStart);
    const baseRule = css.slice(baseStart, baseEnd);
    assert.match(baseRule, /background:\s*var\(--surface\)/);
    assert.match(baseRule, /color:\s*var\(--ink\)/);
    assert.match(baseRule, /font-weight:\s*600/);

    const checkboxStart = css.indexOf(".job-option input:checked");
    const checkboxEnd = css.indexOf(".job-option-icon {");
    assert.ok(checkboxStart >= 0 && checkboxEnd > checkboxStart);
    const checkboxRules = css.slice(checkboxStart, checkboxEnd);
    assert.match(checkboxRules, /background:\s*var\(--accent\)/);

    const selectedStart = css.indexOf(".job-option:has(input:checked) {");
    const selectedEnd = css.indexOf(".job-option:has(input:checked) .job-option-icon");
    assert.ok(selectedStart >= 0 && selectedEnd > selectedStart);
    const selectedRule = css.slice(selectedStart, selectedEnd);
    assert.match(selectedRule, /border-color:\s*var\(--accent\)/);
    assert.match(selectedRule, /background:\s*var\(--surface\)/);
    assert.doesNotMatch(selectedRule, /var\(--danger\)/);
});

test("delete-source icon has an intrinsic size when styles are unavailable", () => {
    const jobBar = html.slice(
        html.indexOf('class="job-bar"'),
        html.indexOf('class="work-grid"'),
    );
    assert.match(
        jobBar,
        /class="job-option-icon"[\s\S]*?<svg[^>]*width="14"[^>]*height="14"/,
    );
});

test("header history control keeps the same pill treatment as the theme toggle", () => {
    const start = css.indexOf(".header-right .task-center-btn {");
    const end = css.indexOf(".task-center-dialog {");
    assert.ok(start >= 0 && end > start);
    const rule = css.slice(start, end);
    assert.match(rule, /min-height:\s*34px/);
    assert.match(rule, /border-radius:\s*var\(--radius-pill\)/);
});
