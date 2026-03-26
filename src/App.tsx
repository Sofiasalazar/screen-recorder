import { Header } from './components/Header';
import { DataNotice } from './components/DataNotice';
import { FooterCTA } from './components/FooterCTA';
import { SetupScreen } from './components/SetupScreen';
import { RecordingScreen } from './components/RecordingScreen';
import { PlaybackScreen } from './components/PlaybackScreen';
import { useScreenRecorder } from './hooks/useScreenRecorder';
import { useMediaDevices } from './hooks/useMediaDevices';
import { useRecordingTimer } from './hooks/useRecordingTimer';

export default function App() {
  const {
    state,
    preferences,
    updatePreferences,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetRecording,
  } = useScreenRecorder();

  const { cameras, microphones, permissionGranted, requestPermission, error: deviceError } = useMediaDevices();

  const isTimerRunning = state.phase === 'recording';
  const { elapsed, reset: resetTimer } = useRecordingTimer(isTimerRunning);

  const handleReset = () => {
    resetRecording();
    resetTimer();
  };

  return (
    <div className="h-screen flex flex-col bg-brand-bg">
      <Header phase={state.phase} />
      <DataNotice />

      {state.phase === 'setup' && (
        <SetupScreen
          cameras={cameras}
          microphones={microphones}
          preferences={preferences}
          permissionGranted={permissionGranted}
          onPreferencesChange={updatePreferences}
          onRequestPermission={requestPermission}
          onStart={startRecording}
          error={state.error || deviceError}
        />
      )}

      {(state.phase === 'recording' || state.phase === 'paused') && (
        <RecordingScreen
          compositeStream={state.compositeStream}
          cameraStream={state.cameraStream}
          cameraEnabled={preferences.cameraEnabled}
          isPaused={state.phase === 'paused'}
          elapsedSeconds={elapsed}
          onPause={pauseRecording}
          onResume={resumeRecording}
          onStop={stopRecording}
        />
      )}

      {state.phase === 'playback' && state.recordedBlob && state.recordedUrl && (
        <PlaybackScreen
          recordedUrl={state.recordedUrl}
          recordedBlob={state.recordedBlob}
          onReset={handleReset}
        />
      )}

      <FooterCTA />
    </div>
  );
}
