on run arguments
    set processID to (item 1 of arguments) as integer
    set deadline to (current date) + 75
    tell application "System Events"
        repeat while (current date) < deadline
            set matchingProcesses to every application process whose unix id is processID
            if (count of matchingProcesses) > 0 then
                set testProcess to item 1 of matchingProcesses
                if (count of windows of testProcess) > 0 then
                    set elements to entire contents of front window of testProcess
                    repeat with elementRef in elements
                        try
                            if role of elementRef is "AXButton" then
                                if name of elementRef is "立即更新" or description of elementRef is "立即更新" then
                                    perform action "AXPress" of elementRef
                                    return "FineShell update button pressed."
                                end if
                            end if
                        end try
                    end repeat
                end if
            end if
            delay 1
        end repeat
    end tell
    error "FineShell update button was not found."
end run
