/** Merge preparation uses fixed sensor white, common gains, and sensor-site clipping. */
export const mergePrepareShader = /* wgsl */ `
struct Params { size:vec4u, crop:vec4u, sensor:vec4u, cfa:vec4u, thresholds:vec4f, camera:array<vec4f,3>, review:vec4u }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> raw:array<u32>;
@group(0) @binding(2) var<storage,read_write> saturated:array<u32>;
@group(0) @binding(3) var camera: texture_2d<f32>;
@group(0) @binding(4) var prepared:texture_storage_2d<rgba32float,write>;
@group(0) @binding(5) var<storage,read> lut:array<vec4f>;
@group(0) @binding(6) var pixels:texture_2d<f32>;
@group(0) @binding(7) var<storage,read_write> reduced:array<vec4f>;
fn radial(r:f32)->vec4f { let pos=clamp(r*4095.,0.,4095.); let i=min(4094u,u32(pos)); return mix(lut[i],lut[i+1u],vec4f(pos-f32(i))); }
@compute @workgroup_size(16,16) fn saturation(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=p.size.xy)) { return; }
  var clipped=0u;
  for(var dy=-2;dy<=2;dy++) { for(var dx=-2;dx<=2;dx++) {
    let q=clamp(vec2i(id.xy)+vec2i(dx,dy),vec2i(0),vec2i(p.size.xy)-1);
    let k=(u32(q.y)+p.sensor.z)*p.sensor.x+u32(q.x)+p.sensor.y;
    let value=(raw[k/2u] >> ((k%2u)*16u)) & 65535u;
    let c=p.cfa[(u32(q.y)%2u)*2u+u32(q.x)%2u];
    clipped |= u32(f32(value)>=p.thresholds[c]);
  } }
  saturated[id.y*p.size.x+id.x]=clipped;
}
@compute @workgroup_size(16,16) fn prepare(@builtin(global_invocation_id) id:vec3u) {
  let oriented=select(p.size.zw,p.size.wz,(p.sensor.w & 4u)!=0u);
  if(any(id.xy>=oriented)) { return; }
  var q=select(id.xy,id.yx,(p.sensor.w & 4u)!=0u);
  if((p.sensor.w & 1u)!=0u) { q.x=p.size.z-1u-q.x; }
  if((p.sensor.w & 2u)!=0u) { q.y=p.size.w-1u-q.y; }
  let center=(vec2f(p.size.xy)-1.)*.5; let radius=length(center);
  let delta=vec2f(q+p.crop.xy)-center; let factors=radial(length(delta)/radius);
  var rgb=vec3f(0); var clipped=0u;
  for(var c=0u;c<3u;c++) {
    let position=center+delta*factors[c]; let base=vec2i(floor(position)); let fraction=fract(position);
    for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
      let tap=clamp(base+vec2i(x,y),vec2i(0),vec2i(p.size.xy)-1);
      let weight=select(1.-fraction.x,fraction.x,x==1)*select(1.-fraction.y,fraction.y,y==1);
      rgb[c]+=textureLoad(camera,tap,0)[c]*radial(length(vec2f(tap)-center)/radius).w*weight;
      if(weight>0.) { clipped |= saturated[u32(tap.y)*p.size.x+u32(tap.x)]; }
    } }
  }
  var converted:vec3f;
  for(var c=0u;c<3u;c++) { converted[c]=dot(p.camera[c].xyz,rgb); }
  textureStore(prepared,vec2i(id.xy),vec4f(converted,f32(clipped==0u)));
}
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=p.review.xy)) { return; }
  let size=vec2f(textureDimensions(pixels)); let ratio=size/vec2f(p.review.xy);
  let lo=vec2f(id.xy)*ratio; let hi=vec2f(id.xy+1u)*ratio;
  var rgb=vec3f(0); var valid=true; var unclipped=true; var weight=0.;
  for(var y=i32(floor(lo.y));y<i32(ceil(hi.y));y++) { for(var x=i32(floor(lo.x));x<i32(ceil(hi.x));x++) {
    let w=max(0.,min(hi.x,f32(x+1))-max(lo.x,f32(x)))*max(0.,min(hi.y,f32(y+1))-max(lo.y,f32(y)));
    if(w<=0.) { continue; }
    let v=textureLoad(pixels,vec2i(x,y),0); rgb+=v.rgb*w; weight+=w;
    valid=valid && v.a>0. && dot(v.rgb,vec3f(.2627,.678,.0593))>.0045;
    unclipped=unclipped && v.a>0.;
  } }
  let average=rgb/max(weight,1e-12); let k=(id.y*p.review.x+id.x)*2u;
  reduced[k]=vec4f(average,f32(unclipped));
  reduced[k+1u]=vec4f(select(0.,max(0.,dot(average,vec3f(.2627,.678,.0593))),valid),f32(valid),0.,0.);
}
`
