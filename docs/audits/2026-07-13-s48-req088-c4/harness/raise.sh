osascript -e 'tell application "System Events" to tell process "Electron"
  set frontmost to true
  try
    perform action "AXRaise" of window 1
  end try
end tell' 2>/dev/null
