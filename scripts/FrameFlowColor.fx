uniform float Exposure = 0.0;
uniform float Gamma = 1.0;
uniform float Contrast = 1.0;
uniform float Saturation = 1.0;
texture FrameColor : COLOR;
sampler FrameSampler { Texture = FrameColor; };
void VS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id << 1) & 2, id & 2);
    position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 pixel = tex2D(FrameSampler, uv);
    float3 color = pixel.rgb * exp2(Exposure);
    color = pow(max(color, 0.0), 1.0 / max(Gamma, 0.1));
    color = (color - 0.5) * Contrast + 0.5;
    float luminance = dot(color, float3(0.2126, 0.7152, 0.0722));
    return float4(saturate(lerp(luminance.xxx, color, Saturation)), pixel.a);
}
technique FrameFlowColor { pass { VertexShader = VS; PixelShader = PS; } }
