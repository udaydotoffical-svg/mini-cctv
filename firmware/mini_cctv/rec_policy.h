#pragma once
#include <stdint.h>

// When to start and stop recording a clip. Pure logic, tested on a PC by tools/test_features.cpp.
//
//  * Manual: the Stick (or a browser) starts and stops a clip.
//  * Automatic: motion starts a clip and it runs until things have been quiet for `tailMs`.
//  * Either way a clip never exceeds `maxClipMs` (a new one starts at once if motion continues,
//    after a short cooldown), and nothing starts without a working SD card.

struct RecConfig {
    bool autoOnMotion;
    uint32_t tailMs;     // keep recording this long after the last motion
    uint32_t maxClipMs;
    uint32_t cooldownMs; // minimum gap between clips
};

enum RecAction { REC_NONE = 0, REC_START = 1, REC_STOP = 2 };

struct RecPolicy {
    bool recording;
    bool manual; // this clip was started by hand
    uint32_t startMs;
    uint32_t lastMotionMs;
    uint32_t lastStopMs;
    bool everStopped;
    bool wantManualStart;
    bool wantManualStop;

    void init() {
        recording = false;
        manual = false;
        startMs = lastMotionMs = lastStopMs = 0;
        everStopped = false;
        wantManualStart = wantManualStop = false;
    }
    void requestStart() { wantManualStart = true; }
    void requestStop() { wantManualStop = true; }

    RecAction update(uint32_t now, bool motionActive, bool sdOk, const RecConfig &c) {
        if (motionActive) lastMotionMs = now;
        const bool cooled = !everStopped || (now - lastStopMs) >= c.cooldownMs;

        if (recording) {
            const bool tooLong = (now - startMs) >= c.maxClipMs;
            const bool quiet = !manual && (now - lastMotionMs) >= c.tailMs;
            if (wantManualStop || tooLong || quiet || !sdOk) {
                recording = false;
                manual = false;
                wantManualStop = false;
                wantManualStart = false;
                lastStopMs = now;
                everStopped = true;
                return REC_STOP;
            }
            wantManualStart = false;
            return REC_NONE;
        }

        wantManualStop = false;
        if (sdOk && wantManualStart) {
            wantManualStart = false;
            recording = true;
            manual = true;
            startMs = now;
            return REC_START;
        }
        wantManualStart = false;
        if (sdOk && c.autoOnMotion && motionActive && cooled) {
            recording = true;
            manual = false;
            startMs = now;
            return REC_START;
        }
        return REC_NONE;
    }
};
