const { withVarlockMetroConfig } = require("@varlock/expo-integration/metro-config");
// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

module.exports = withVarlockMetroConfig(config);
