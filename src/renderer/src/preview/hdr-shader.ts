export const hdrShader = `
struct Params { values: array<vec4f, 11> }
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var pixels: texture_2d<f32>;
const luma = vec3f(.2627002120112671, .6779980715188708, .059301716469862);
fn adjusted(input: vec3f) -> vec3f {
  var rgb = input;
  if (u.values[4].w > 0.) { rgb = vec3f(dot(u.values[5].xyz,rgb), dot(u.values[6].xyz,rgb), dot(u.values[7].xyz,rgb)); }
  rgb *= exp2(u.values[2].x);
  var y = dot(rgb,luma);
  let contrast = u.values[2].y;
  if (contrast != 0. && y > 0. && y < 1.) {
    var next = .18 * pow(y/.18,exp2(contrast/100.));
    if (y > .18) { next = 1. - .82 * pow((1.-y)/.82,exp2(contrast/100.)); }
    rgb *= next/y;
  }
  y = dot(rgb,luma);
  let h = u.values[2].z/100.;
  if (h != 0. && y > .18) { rgb *= ((1.+h)*y-h*(.18+.82*(y-.18)/(.82+y-.18)))/y; }
  y = dot(rgb,luma);
  if (u.values[2].w != 0. && y > 0. && y < .18) { rgb *= exp2(2.*u.values[2].w/100.*pow(1.-y/.18,2.)); }
  y = dot(rgb,luma);
  if (u.values[3].x != 0. && y > 0.) { let t = clamp((y-.18)/.82,0.,1.); rgb *= exp2(u.values[3].x/100.*t*t*(3.-2.*t)); }
  y = dot(rgb,luma);
  let b = u.values[3].y/100.;
  if (b != 0. && y >= 0.) {
    let d = .04*b*pow(max(1.-y/.18,0.),3.);
    if (b > 0.) { rgb += vec3f(d); } else if (y > 0.) { rgb *= max(0.,y+d)/y; }
  }
  return rgb;
}
fn outputRgb(rgb: vec3f) -> vec3f {
  let y = dot(rgb,luma);
  if (y <= 0.) { return vec3f(0.); }
  let h = u.values[3].z;
  var mapped = y;
  if (y > .75) { mapped = .75+(h-.75)/(1.+(h-.75)/(y-.75)); }
  let room = select(h-y,(h-.75)*(h-.75)/(h+y-1.5),y>.75);
  let d = vec3f(dot(u.values[8].xyz-luma,rgb),dot(u.values[9].xyz-luma,rgb),dot(u.values[10].xyz-luma,rgb)) * (mapped/y);
  var q = 0.;
  for(var c=0u;c<3u;c++) { q = max(q, select(-d[c]/mapped,d[c]/max(room,1e-20),d[c]>0.)); }
  var factor = 1.;
  if (q > .9) { factor = (.9+.1*(q-.9)/(q-.8))/q; }
  return clamp(fma(d,vec3f(factor),vec3f(mapped)),vec3f(0.),vec3f(h));
}
fn encoded(v: vec3f) -> vec3f { return select(1.055*pow(max(v,vec3f(0.)),vec3f(1./2.4))-.055,12.92*v,v<=vec3f(.0031308)); }
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let positions = array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
  return vec4f(positions[i],0.,1.);
}
fn fetch(p:vec2i, level:i32)->vec4f { return textureLoad(pixels,clamp(p,vec2i(0),vec2i(textureDimensions(pixels,level))-1),level); }
fn sampleImage(p:vec2f)->vec4f {
  if (u.values[1].z >= 1.) { return fetch(vec2i(floor(p)),0); }
  let level = i32(clamp(floor(log2(1./u.values[1].z)),0.,u.values[4].z-1.));
  let point = p/u.values[0].zw*vec2f(textureDimensions(pixels,level))-.5;
  let base = vec2i(floor(point)); let f = fract(point);
  return mix(mix(fetch(base,level),fetch(base+vec2i(1,0),level),f.x),mix(fetch(base+vec2i(0,1),level),fetch(base+vec2i(1,1),level),f.x),f.y);
}
@fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
  let css = position.xy/u.values[1].w;
  let source = (css-u.values[0].xy*.5-u.values[1].xy)/u.values[1].z+u.values[0].zw*.5;
  if (any(source<vec2f(0.)) || any(source>=u.values[0].zw)) { return vec4f(.059,.063,.067,1.); }
  let pixel = sampleImage(source);
  let before = u.values[4].x == 1. || (u.values[4].x == 2. && css.x < u.values[0].x*u.values[4].y);
  var rgb = pixel.rgb;
  if (!before) { rgb = adjusted(rgb); }
  var result = encoded(mix(vec3f(.00478,.0052,.00563),outputRgb(rgb),pixel.a));
  if (u.values[1].z >= 8.) {
    let edge = min(fract(source),1.-fract(source))*u.values[1].z;
    let coverage = clamp((.5+.5/u.values[1].w-min(edge.x,edge.y))*u.values[1].w,0.,1.);
    result = mix(result,vec3f(.5),clamp((u.values[1].z-4.)/12.,0.,1.)*.22*coverage);
  }
  return vec4f(result,1.);
}`

export const hdrMipShader = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn down(@builtin(global_invocation_id) p:vec3u) {
  if(any(p.xy>=textureDimensions(destination))) { return; }
  let size=vec2i(textureDimensions(source)); var sum=vec4f(0.);
  for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
    let v=textureLoad(source,min(vec2i(p.xy)*2+vec2i(x,y),size-1),0);
    sum+=vec4f(v.rgb*v.a,v.a);
  }}
  textureStore(destination,p.xy,vec4f(select(vec3f(0.),sum.rgb/max(sum.a,1e-20),sum.a>0.),sum.a*.25));
}`
