#pragma once
// Operating modes of the camera. Pure C++, tested on a PC by tools/test_features.cpp.
//
// The mode lives on the camera (and is saved to flash), not on the Stick, because a security
// service has to keep working while nobody is looking: the camera records and watches for motion
// on its own, and the Stick just looks in when you want.
//
//   LIVE        just a picture. Nothing else runs, so it is the lightest and fastest.
//   GUARD       live + motion detection + DVR rewind. The Stick can alert you. Nothing is stored.
//   SECURITY    the full service: motion alerts, DVR rewind, a photo when motion starts, and a
//               video clip recorded to the SD card for every event. Works with nobody watching.
//   CONTINUOUS  records video all the time (clips back to back, oldest deleted when the card is
//               full), plus motion alerts and DVR rewind.
//   TIMELAPSE   a photo to the SD card every N seconds.
//
// Photos and recording can always be started by hand from the Stick in any mode (with an SD card).

#define MODE_LIVE       0
#define MODE_GUARD      1
#define MODE_SECURITY   2
#define MODE_CONTINUOUS 3
#define MODE_TIMELAPSE  4
#define MODE_COUNT      5

struct ModeCaps {
    bool motion;     // run motion detection
    bool history;    // keep the DVR rewind buffer
    bool autoRec;    // record a clip for every motion event
    bool continuous; // record all the time
    bool timelapse;  // photo every N seconds
    bool eventPhoto; // photo when motion starts
    bool alerts;     // the Stick should alert on motion
    bool needsSd;    // the mode is only really useful with an SD card
};

static inline ModeCaps modeCaps(int m) {
    //                       motion history autoRec cont  timelapse evPhoto alerts needsSd
    switch (m) {
        case MODE_GUARD:      return {true,  true,  false, false, false, false, true,  false};
        case MODE_SECURITY:   return {true,  true,  true,  false, false, true,  true,  true};
        case MODE_CONTINUOUS: return {true,  true,  false, true,  false, false, true,  true};
        case MODE_TIMELAPSE:  return {false, false, false, false, true,  false, false, true};
        default:              return {false, false, false, false, false, false, false, false};
    }
}

static inline const char *modeName(int m) {
    static const char *n[MODE_COUNT] = {"Live", "Guard", "Security", "Continuous", "Timelapse"};
    return (m >= 0 && m < MODE_COUNT) ? n[m] : "?";
}

// One-line description for the Stick's menu footer (fits ~38 characters).
static inline const char *modeBlurb(int m) {
    static const char *b[MODE_COUNT] = {
        "Just the picture. Fastest.",
        "Motion alerts + rewind. Stores nothing.",
        "Alerts, photo + clip per event, rewind.",
        "Records all the time + alerts + rewind.",
        "A photo to the SD card every N seconds.",
    };
    return (m >= 0 && m < MODE_COUNT) ? b[m] : "";
}
