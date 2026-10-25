import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("XRA_BACKEND_AUTOPROVISION", "0")
import xr_server


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg and FFprobe are required")
class RecordingAudioCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory(prefix="xra-audio-fixtures-")
        cls.fixture_dir = Path(cls.fixtures.name)
        cls.voice = cls.fixture_dir / "voice.wav"
        cls.video = cls.fixture_dir / "video.webm"
        cls.silence = cls.fixture_dir / "silence.wav"
        cls.run_ffmpeg(
            "-f", "lavfi", "-i", "sine=frequency=240:sample_rate=48000:duration=3",
            "-af", "volume=0.04", "-c:a", "pcm_s16le", cls.voice,
        )
        cls.run_ffmpeg(
            "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10:d=3",
            "-i", cls.voice, "-c:v", "libvpx", "-deadline", "realtime",
            "-c:a", "libopus", "-shortest", cls.video,
        )
        cls.run_ffmpeg(
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
            "-t", "3", "-c:a", "pcm_s16le", cls.silence,
        )

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    @staticmethod
    def run_ffmpeg(*args):
        return subprocess.run(
            [FFMPEG, "-v", "error", "-nostdin", "-y", *map(str, args)],
            capture_output=True, check=True,
        ).stdout

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="xra-audio-test-")
        self.folder = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def info(self, source=None, final=None, **extra):
        return {
            "path": source or self.voice, "final_path": final or self.folder / "out.wav",
            "mode": "audio", "output_format": "wav", "audio_bps": 128000,
            "audio_cleanup": True, "noise_reduction_db": 10, **extra,
        }

    @staticmethod
    def probe(path):
        result = subprocess.run(
            [FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)

    @staticmethod
    def video_packets(path):
        result = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v", "-show_packets",
             "-show_data_hash", "sha256", "-of", "json", str(path)],
            capture_output=True, text=True, check=True,
        )
        return [item["data_hash"] for item in json.loads(result.stdout)["packets"]]

    def test_quiet_voice_reaches_target_and_preserves_duration(self):
        source = self.folder / "source.wav"
        shutil.copy2(self.voice, source)
        info = self.info(source=source)
        output = xr_server.convert_recording(info)
        measured = xr_server._measure_recording_loudness(FFMPEG, output)
        self.assertAlmostEqual(measured["input_i"], -18, delta=0.4)
        self.assertLessEqual(measured["input_tp"], -0.9)
        self.assertAlmostEqual(float(self.probe(output)["format"]["duration"]), 3, delta=0.001)
        self.assertFalse(source.exists())

    def test_webm_processing_keeps_video_packets_and_handles_same_path(self):
        source = self.folder / "same.webm"
        shutil.copy2(self.video, source)
        packets = self.video_packets(source)
        info = self.info(source, source, mode="video_audio", output_format="webm")
        xr_server.convert_recording(info)
        self.assertEqual(self.video_packets(source), packets)
        self.assertAlmostEqual(float(self.probe(source)["format"]["duration"]), 3, delta=0.05)
        self.assertAlmostEqual(xr_server._measure_recording_loudness(FFMPEG, source)["input_i"], -18, delta=0.4)

    def test_raw_backup_keeps_original_samples(self):
        source = self.folder / "source.wav"
        shutil.copy2(self.voice, source)
        original = self.run_ffmpeg("-i", source, "-f", "s16le", "-")
        output = xr_server.convert_recording(self.info(
            source, self.folder / "raw.flac", output_format="flac", audio_cleanup=False,
        ))
        decoded = self.run_ffmpeg("-i", output, "-f", "s16le", "-")
        self.assertEqual(original, decoded)

    def test_zero_noise_reduction_does_not_shift_or_extend_audio(self):
        source = self.folder / "source.wav"
        shutil.copy2(self.voice, source)
        output = xr_server.convert_recording(self.info(source=source, noise_reduction_db=0))
        self.assertAlmostEqual(float(self.probe(output)["format"]["duration"]), 3, delta=0.001)
        self.assertAlmostEqual(xr_server._measure_recording_loudness(FFMPEG, output)["input_i"], -18, delta=0.4)

    def test_silence_is_not_amplified(self):
        source = self.folder / "silence.wav"
        shutil.copy2(self.silence, source)
        output = xr_server.convert_recording(self.info(source=source))
        decoded = self.run_ffmpeg("-i", output, "-f", "s16le", "-")
        self.assertTrue(decoded)
        self.assertFalse(any(decoded))

    def test_failed_encode_preserves_source_and_removes_partial_output(self):
        source = self.folder / "same.webm"
        shutil.copy2(self.video, source)
        original = source.read_bytes()

        def fail(common, output, *args):
            output.write_bytes(b"partial output")
            raise RuntimeError("simulated encoder failure")

        with patch.object(xr_server, "_recording_audio_filter", return_value="anull"), \
             patch.object(xr_server, "_convert_recording_output", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "simulated"):
                xr_server.convert_recording(self.info(source, source, output_format="webm"))
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(list(self.folder.iterdir()), [source])

    def test_native_mux_uses_processed_audio_and_preserves_video(self):
        video = self.folder / "video.webm"
        audio = self.folder / "audio.wav"
        shutil.copy2(self.video, video)
        shutil.copy2(self.voice, audio)
        packets = self.video_packets(video)
        output = xr_server.finalize_native_recording(
            self.info(video, self.folder / "native.webm", mode="video_audio", output_format="webm"),
            self.info(audio),
        )
        self.assertEqual(self.video_packets(output), packets)
        self.assertAlmostEqual(float(self.probe(output)["format"]["duration"]), 3, delta=0.05)
        self.assertAlmostEqual(xr_server._measure_recording_loudness(FFMPEG, output)["input_i"], -18, delta=0.4)

    def test_audio_formats_are_finalized(self):
        for extension in ("mp4", "mkv", "opus", "flac"):
            with self.subTest(extension=extension):
                source = self.folder / f"source-{extension}.wav"
                shutil.copy2(self.voice, source)
                output = xr_server.convert_recording(self.info(
                    source, self.folder / f"out.{extension}", output_format=extension,
                ))
                self.assertTrue(output.stat().st_size)
                audio = [item for item in self.probe(output)["streams"] if item["codec_type"] == "audio"]
                self.assertEqual(len(audio), 1)

    def test_recovery_manifest_keeps_processing_options(self):
        with patch.object(xr_server, "RECORDING_MANIFEST_DIR", self.folder):
            xr_server.write_recording_manifest("example", self.info(noise_reduction_db=7))
        saved = json.loads((self.folder / "example.json").read_text())
        self.assertIs(saved["audio_cleanup"], True)
        self.assertEqual(saved["noise_reduction_db"], 7)


if __name__ == "__main__":
    unittest.main()
