# Avatar upload behavior

The profile and platform avatar pickers are designed to behave like a mobile Telegram avatar picker:

- the picker opens the phone photo library through `image/*`;
- common mobile formats, including HEIC/HEIF when the browser can decode them, are accepted;
- large or non-native images are converted locally to JPEG before the existing avatar pipeline runs;
- EXIF orientation is respected where the browser exposes it;
- the existing profile module performs the final square crop and storage-size compression;
- the original photo is not uploaded or retained.

The browser must be able to decode the selected image. When a browser cannot decode HEIC/HEIF, the user is asked to save or share a JPG copy from the phone photo library.
