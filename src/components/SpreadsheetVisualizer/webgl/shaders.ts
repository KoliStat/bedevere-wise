// GLSL shader sources for the WebGL2 spike. Kept inline (template strings)
// so the spike has no build-system surface — Vite ships it as a regular
// string literal. WebGL2 (300 es) is required for `instanceID` and the
// in/out qualifiers.

/**
 * Instanced quad vertex shader.
 *
 * The geometry is a single unit quad (positions 0..1 in `a_corner`); each
 * instance carries its own (x, y, w, h) rectangle and (r, g, b, a) color.
 * The vertex shader maps the unit-quad corner into the rectangle, then to
 * NDC via an orthographic projection (`u_projection`). One draw call →
 * thousands of cells.
 */
export const RECT_VS = /* glsl */ `#version 300 es
in vec2 a_corner;
in vec4 a_rect;     // (x, y, w, h) in CSS pixels
in vec4 a_color;    // RGBA, 0..1

uniform mat4 u_projection;

out vec4 v_color;

void main() {
  vec2 p = a_rect.xy + a_corner * a_rect.zw;
  gl_Position = u_projection * vec4(p, 0.0, 1.0);
  v_color = a_color;
}
`;

/**
 * Trivial fragment shader — pass the per-instance color through. No
 * texture sampling, no per-fragment work; rect rendering is geometry-bound,
 * not fill-bound, at our cell count.
 */
export const RECT_FS = /* glsl */ `#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = v_color;
}
`;

/**
 * Textured-quad shaders (used for the text overlay and any glyph atlas).
 * The text canvas is uploaded as a single texture and blitted as one quad.
 */
export const TEX_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  // a_pos is already in NDC for the simple fullscreen-quad case.
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
}
`;

export const TEX_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`;
