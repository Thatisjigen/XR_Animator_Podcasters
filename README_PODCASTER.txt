===============================================================================
              XR ANIMATOR PODCASTERS EDITION · USER MANUAL
===============================================================================

Welcome to the special edition of XR Animator optimized for Podcasters,
Streamers, and Virtual Creators (VTubers). This guide covers all key features,
recommended settings to prevent posture glitches, and step-by-step instructions
for optimal performance.

-------------------------------------------------------------------------------
1. OVERVIEW OF PANELS & CONTROLS
-------------------------------------------------------------------------------

The interface is organized into two collapsible side panels:

* RIGHT PANEL (Control Panel):
  The main operational cockpit. From here you manage:
  - 💬 Studio Link: P2P audio, chat, and ultra-smooth screen sharing.
  - 🔴 Recording: High-fidelity video and audio capture with raw FLAC backup.
  - 🧍 Body & Tracking: Torso stabilization, body anchoring, and anti-glitch guards.
  - 🎤 Audio & Lip-Sync: Smart Noise Gate auto-calibration and voice levels.
  - 🎮 Performance & GPU: Viewport render framerate (30/60 FPS), resolution, presets.

* LEFT PANEL (XRP Settings):
  The native engine drawer. From here you manage:
  - Loading and switching avatars (VRM and MMD PMX models).
  - Pose library management with quick [↺ Reset pose] button.
  - Fine shoulder adjustments (Shoulder adjust) and native tracking parameters.
  - Quick [✕ CLOSE] button in the upper-left corner to quit safely.

-------------------------------------------------------------------------------
2. HOW TO PREVENT AVATAR GLITCHES / FALLING DOWN (SITTING AT DESK)
-------------------------------------------------------------------------------

When sitting at a desk, your webcam only sees your head and upper torso:
your hips, knees, and feet are hidden under the table.
The AI tracking algorithm tries to guess the position of your lower body. If
fooled by shadows, clothing, or desk edges, it may hallucinate that you are
lying down or bent backwards, causing your avatar to collapse or fly off into
a corner.

TO PREVENT ALL POSTURE GLITCHES, ENABLE THE "DESK COMBO":
In the right panel, expand the [🧍 Body] section and configure:

  [X] Body stabilization (ENABLED)
      -> Firmly locks hips, pelvis, and legs in a natural seated pose. Head,
         mouth, arms, and hands remain 100% live, but your avatar can NEVER
         fall, tilt, or fly across the room.
  
  [X] Anchor strength: 80% - 90%
      -> Controls anchoring rigidity. Values above 80% guarantee rock-solid
         posture stability.
  
  [X] Motion hysteresis (anti-jerk) (ENABLED)
      -> Anti-jolt filter: if the camera drops a frame or detects an anomalous
         spurious pose jump, the filter discards the anomaly and holds the
         last valid pose (HOLDING LAST VALID) until coherent frames return.
  
  [X] Tracking loss protection (ENABLED)
      -> If you lean down or step away from the webcam, it freezes the avatar
         in a composed neutral pose while microphone lip-sync remains live.
  
  [*] Button [🎯 Recapture reference pose] (under Advanced):
      -> Sit comfortably and upright in front of your PC, then click this button
         once to memorize your ideal seated posture.

If the avatar ever takes an awkward angle, simply click [↺ Reset pose] in the
left panel to instantly restore the neutral stance.

-------------------------------------------------------------------------------
3. SMART NOISE GATE WITH AUTO-CALIBRATION (-80 dB)
-------------------------------------------------------------------------------

The recording Noise Gate automatically silences the microphone during pauses,
eliminating room reverb, PC fan hum, and breathing sounds.

HOW TO CALIBRATE IN 3 SECONDS:
1. In the right panel, open [🎤 Audio & Lip-sync].
2. Stay completely quiet for 3 seconds.
3. Click the button [🎚 Calibra rumore stanza (3s) / Calibrate room noise].
4. The engine measures your room noise floor (e.g. -66.1 dB) and automatically
   sets the ideal threshold at +5 dB above the noise (e.g. -61.0 dB).
5. The manual slider moves automatically to the calculated value.

MANUAL ADJUSTMENT:
The "Soglia Noise Gate registrazione" slider supports an extended range
from -80 dB to -5 dB in 0.5 dB steps.
- If your voice cuts out at the start of words: move the slider to the left (e.g. -65 dB).
- If background noise still leaks in: move the slider to the right (e.g. -50 dB).

-------------------------------------------------------------------------------
4. STUDIO LINK · P2P CALLS, VOICE & SCREEN SHARING
-------------------------------------------------------------------------------

Studio Link allows two remote podcasters to connect over encrypted, direct
Peer-to-Peer audio, chat, and screen sharing with zero third-party servers.

* CONNECTING:
  - PeerJS mode (Short ID): click [Copy invite ID], send it to your co-host;
    they paste it and click [Connect].
  - Nostr mode: decentralized P2P pairing using xra1_... tokens.

* SCREEN SHARING & "FRACTAL BREAKER" ENGINE:
  - Click [Share screen] (or click the empty video stage).
  - The remote guest receives your screen smoothly at full 30 FPS and resolution.
  - Responsive letterboxed view: your full screen is visible without clipping.
  - "Fractal Breaker" protection: if you accidentally share your full desktop
    while Studio Link is visible, the local preview is downscaled onto a canvas
    at ~12.5 FPS, breaking the infinite mirror loop and preventing CPU freezes.
  - Only the participant who started sharing can stop it via [Stop share].

* CHAT MANAGEMENT:
  - Click [—] in the chat header to minimize the conversation panel.
  - A green badge alerts you to unread messages (1..99, 99+) with a red
    divider line marking incoming unread messages.

-------------------------------------------------------------------------------
5. LOW-SPEC PRESET (OPTIMIZED FOR INTEL CORE i5 10th GEN / INTEGRATED GPU)
-------------------------------------------------------------------------------

Included in this distribution is the pre-tuned profile:
  -> xra_profile_example_low_spec.json

This preset is fine-tuned for mid-range CPUs or laptops with integrated graphics
(such as Intel UHD Graphics 630 on 10th Gen Core i5):
- Viewport 3D rendering: Stable 30 FPS.
- Viewport resolution: 720p (low GPU memory pressure).
- Post-processing (Bloom, Ambient Occlusion, Depth of Field): Disabled.
- Video recording: 720p at 30 FPS with 2.5 Mbps video bitrate (fast CPU encoding).
- Body stabilization and Noise Gate: Pre-configured.

To apply this preset:
1. Rename or copy `xra_profile_example_low_spec.json` to `xra_profile.json`
   in the root directory of XR Animator.
2. Launch XR Animator: the profile will be applied automatically.

-------------------------------------------------------------------------------
6. HOW TO SWITCH TO 60 FPS (RENDERING & RECORDING)
-------------------------------------------------------------------------------

If you upgrade your system or have a dedicated graphics card (Nvidia RTX /
AMD Radeon) and want ultra-smooth 60 FPS broadcast quality, follow these steps
in the RIGHT PANEL:

STEP 1 · VIEWPORT RENDERING AT 60 FPS (On-screen smoothness):
1. Open the right panel and expand [⚡ Performance].
2. Expand [Advanced performance].
3. Expand [🎮 Rendering Grafico & GPU / Graphics Rendering & GPU].
4. Under "Render FPS", change the dropdown from "30 FPS" to [60 FPS]
   (or "Unlimited / Monitor" for 144 Hz displays).
5. Under "Render resolution", choose [1080p (Full HD)].

STEP 2 · RECORDING AT 60 FPS (Saved video smoothness):
1. In the right panel, open [🔴 Registrazione / Recording].
2. In the "FPS" field, change the value to [60].
3. For Full HD recording:
   - Resolution: Width 1920, Height 1080.
   - Video bitrate: set to 5000000 (5 Mbps) or 6000000 (6 Mbps).
4. Click [Save settings] at the bottom of the panel.

NOTE ON POST-FX AT 60 FPS:
If you have a dedicated Nvidia GPU, you can expand [Visual Effects / Bloom]
and enable UnrealBloom to add realistic lighting highlights to your model's
clothing and eyes. If you experience frame drops, keep N8AO disabled.

===============================================================================
                       HAPPY RECORDING & STREAMING!
===============================================================================
