/** Replace a camera only once the new stream is playing. A failed choice keeps the old one. */
export async function openCamera(video: HTMLVideoElement, deviceId = '', width = 1280, height = 720) {
  const previous = video.srcObject as MediaStream | null
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) },
  })
  try {
    video.srcObject = stream
    await video.play()
  } catch (error) {
    video.srcObject = previous
    stream.getTracks().forEach(track => track.stop())
    throw error
  }
  previous?.getTracks().forEach(track => track.stop())
}
