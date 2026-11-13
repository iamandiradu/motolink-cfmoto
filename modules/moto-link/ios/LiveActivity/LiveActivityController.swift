// Starts, updates and ends the ride Live Activity. Deliberately free of
// ExpoModulesCore so it stays a plain Swift unit: the Expo module forwards a
// JS object as [String: Any] and gets a Bool back, and nothing here can throw
// across the bridge.

import Foundation
import os

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
public final class LiveActivityController {
  public typealias State = RideActivityAttributes.ContentState

  /// iOS budgets Live Activity updates; frequent ones get silently dropped
  /// or throttled for the rest of the session. Speed changes every GPS tick,
  /// so ordinary updates are coalesced to at most one per this interval.
  /// Link-state and mirroring changes bypass it because they are what the
  /// rider glances at the lock screen for.
  public static let minUpdateInterval: TimeInterval = 5

  /// If the app dies mid-ride the activity would otherwise keep showing the
  /// last speed forever. A stale date lets the widget render "Paused"
  /// instead. Each update pushes it forward.
  static let staleAfter: TimeInterval = 120

  /// Identical states are skipped, but still re-sent after this long so the
  /// stale date keeps moving while the bike sits at a red light.
  static let keepAliveInterval: TimeInterval = 60

  private static let log = Logger(subsystem: "com.iamandiradu.motolink", category: "LiveActivity")

  // All mutable state is guarded by `lock`; callers may come from the JS
  // thread, the location callback or the link server queue. Hence
  // nonisolated(unsafe): the lock, not the compiler, provides the safety.
  private static let lock = NSLock()
  nonisolated(unsafe) private static var activity: Activity<RideActivityAttributes>?
  nonisolated(unsafe) private static var lastSent: State?
  nonisolated(unsafe) private static var lastSentAt: Date = .distantPast
  nonisolated(unsafe) private static var pending: State?
  nonisolated(unsafe) private static var flushScheduled = false

  private init() {}

  // MARK: - Public API

  /// False when the user has turned Live Activities off for the app (or the
  /// device cannot show them). Cheap; safe to call on any thread.
  public static var isSupported: Bool {
    ActivityAuthorizationInfo().areActivitiesEnabled
  }

  /// True while an activity this process knows about is still on screen.
  public static var isActive: Bool {
    lock.lock(); defer { lock.unlock() }
    return liveActivityLocked() != nil
  }

  /// Starts the ride activity, or updates the existing one if a ride is
  /// already showing (including one left over from a previous app launch).
  /// Must be called while the app is in the foreground: iOS rejects
  /// request() from the background. Returns false if nothing is showing.
  @discardableResult
  public static func start(state: State) -> Bool {
    guard isSupported else {
      log.info("start skipped: Live Activities disabled")
      return false
    }

    lock.lock()
    if liveActivityLocked() != nil {
      lock.unlock()
      return update(state: state, force: true)
    }
    lock.unlock()

    do {
      let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(staleAfter))
      let created = try Activity<RideActivityAttributes>.request(
        attributes: RideActivityAttributes(),
        content: content,
        pushType: nil
      )
      lock.lock()
      activity = created
      lastSent = state
      lastSentAt = Date()
      pending = nil
      lock.unlock()
      log.info("started activity \(created.id, privacy: .public)")
      return true
    } catch {
      log.error("request failed: \(error.localizedDescription, privacy: .public)")
      return false
    }
  }

  /// Pushes a new state, throttled (see `minUpdateInterval`). Returns true
  /// when the state was sent or queued, false when there is no activity to
  /// update (call `start` first). The newest state always wins: a throttled
  /// update is delivered at the end of the window, not dropped.
  @discardableResult
  public static func update(state: State) -> Bool {
    update(state: state, force: false)
  }

  /// Ends every ride activity immediately. Safe to call when none exists.
  public static func end() {
    lock.lock()
    let final = pending ?? lastSent
    activity = nil
    lastSent = nil
    pending = nil
    lastSentAt = .distantPast
    lock.unlock()

    // End all, not just ours: an activity orphaned by a crash or reinstall is
    // not referenced by `activity` but still sits on the lock screen.
    for running in Activity<RideActivityAttributes>.activities {
      let content = final.map { ActivityContent(state: $0, staleDate: nil) }
      Task {
        await running.end(content, dismissalPolicy: .immediate)
      }
    }
  }

  // MARK: - Dictionary entry points (for the Expo module)

  /// Keys: linkState (String, required), mirroring (Bool), speed (number or
  /// null), speedUnit (String), tripText (String), trackTitle (String or null).
  @discardableResult
  public static func start(state dict: [String: Any]) -> Bool {
    guard let state = Self.state(from: dict) else { return false }
    return start(state: state)
  }

  @discardableResult
  public static func update(state dict: [String: Any]) -> Bool {
    guard let state = Self.state(from: dict) else { return false }
    return update(state: state)
  }

  /// Lenient parse: JS numbers arrive as Double/NSNumber and absent optionals
  /// as NSNull, so both are tolerated. Only a missing linkState is fatal,
  /// because the widget cannot draw anything meaningful without it.
  public static func state(from dict: [String: Any]) -> State? {
    guard let linkState = dict["linkState"] as? String, !linkState.isEmpty else {
      log.error("state dictionary missing linkState")
      return nil
    }
    let speed: Int? = {
      switch dict["speed"] {
      case let n as NSNumber: return n.doubleValue.isFinite ? Int(n.doubleValue.rounded()) : nil
      case let i as Int: return i
      case let d as Double: return d.isFinite ? Int(d.rounded()) : nil
      default: return nil
      }
    }()
    let mirroring = (dict["mirroring"] as? Bool) ?? (dict["mirroring"] as? NSNumber)?.boolValue ?? false
    let title = (dict["trackTitle"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    return State(
      linkState: linkState,
      mirroring: mirroring,
      speed: speed.map { max(0, $0) },
      speedUnit: (dict["speedUnit"] as? String) ?? "km/h",
      tripText: (dict["tripText"] as? String) ?? "",
      trackTitle: title
    )
  }

  // MARK: - Internals

  private static func update(state: State, force: Bool) -> Bool {
    lock.lock()
    guard liveActivityLocked() != nil else {
      lock.unlock()
      return false
    }

    let now = Date()
    let previous = pending ?? lastSent
    let urgent = force
      || previous == nil
      || previous?.linkState != state.linkState
      || previous?.mirroring != state.mirroring

    if !urgent, state == lastSent, pending == nil,
       now.timeIntervalSince(lastSentAt) < keepAliveInterval {
      lock.unlock()
      return true
    }

    let wait = minUpdateInterval - now.timeIntervalSince(lastSentAt)
    if urgent || wait <= 0 {
      pending = nil
      sendLocked(state, at: now)
      lock.unlock()
      return true
    }

    // Inside the throttle window: remember the newest state and flush it
    // once the window closes.
    pending = state
    if !flushScheduled {
      flushScheduled = true
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + wait) {
        flushPending()
      }
    }
    lock.unlock()
    return true
  }

  private static func flushPending() {
    lock.lock()
    flushScheduled = false
    if let state = pending, liveActivityLocked() != nil {
      pending = nil
      sendLocked(state, at: Date())
    }
    lock.unlock()
  }

  /// Caller holds `lock`. The ActivityKit call itself is async and runs
  /// outside the lock in a Task.
  private static func sendLocked(_ state: State, at now: Date) {
    guard let target = activity else { return }
    lastSent = state
    lastSentAt = now
    let content = ActivityContent(state: state, staleDate: now.addingTimeInterval(staleAfter))
    Task {
      await target.update(content)
    }
  }

  /// Caller holds `lock`. Returns the activity if it can still be updated,
  /// adopting one left by an earlier launch so a relaunch mid-ride does not
  /// stack a second activity on the lock screen.
  private static func liveActivityLocked() -> Activity<RideActivityAttributes>? {
    if let current = activity, current.activityState == .active || current.activityState == .stale {
      return current
    }
    // Ours was dismissed by the user or ended; forget it and look for another.
    activity = Activity<RideActivityAttributes>.activities.first {
      $0.activityState == .active || $0.activityState == .stale
    }
    if activity == nil {
      lastSent = nil
      pending = nil
    }
    return activity
  }
}
#endif
