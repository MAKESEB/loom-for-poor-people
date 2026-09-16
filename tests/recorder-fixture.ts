// Vite dev-only browser fixture: real MediaRecorder encoding and API/storage,
// with a deterministic canvas in place of the operating system screen picker.
if (!import.meta.env.DEV) throw new Error('This fixture is for local verification only.');
const canvas = document.createElement('canvas');
canvas.width = 1280;
canvas.height = 720;
const context = canvas.getContext('2d')!;
let frame = 0;
function draw() {
  context.fillStyle = '#f3f0e9';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#e45137';
  context.fillRect(120 + Math.sin(frame / 30) * 60, 160, 160, 160);
  context.fillStyle = '#222a30';
  context.font = 'bold 54px sans-serif';
  context.fillText('Little Loom · recording test', 120, 430);
  context.font = '28px sans-serif';
  context.fillText(`Real video frame ${frame++}`, 120, 490);
  requestAnimationFrame(draw);
}
draw();
Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => canvas.captureStream(30), configurable: true });
await import('../src/main');
