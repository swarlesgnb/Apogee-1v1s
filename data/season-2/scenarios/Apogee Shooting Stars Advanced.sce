Name=Apogee Shooting Stars Advanced
PlayerCharacters=Player
BotCharacters=Apogee Shooting Stars.bot
IsChallenge=true
OvershotProtectionTimer=0.0
Timelimit=60.0
PlayerProfile=Player
AddedBots=Apogee Shooting Stars.bot;Apogee Shooting Stars.bot;Apogee Shooting Stars.bot;Apogee Shooting Stars.bot;Apogee Shooting Stars.bot;Apogee Shooting Stars.bot
PlayerMaxLives=0
BotMaxLives=0;0;0;0;0;0
PlayerTeam=1
BotTeams=2;2;2;2;2;2
ScoreToWin=1000.0
ScorePerDamage=0.0
ScorePerHit=0.0
ScorePerKill=10.0
ScorePerMidairDirect=0.0
ScorePerAnyDirect=0.0
ScoreLossPerDamageTaken=0.0
ScoreLossPerDeath=0.0
ScoreLossPerMidairDirected=0.0
ScoreLossPerAnyDirected=0.0
ScoreMultAccuracy=false
ScoreMultDamageEfficiency=false
ScoreMultKillEfficiency=false
ScorePerTime=0.0
ScorePerDistance=0.0
MBSEnable=false
MBSTime1=0.25
MBSTime2=0.5
MBSTime3=0.75
MBSTime1Mult=1.0
MBSTime2Mult=2.0
MBSTime3Mult=3.0
MBSFBInstead=false
MBSRequireEnemyAlive=false
MaxDistanceTraveledScore=0.0
MaxMBSScore=0.0
DistanceScoreCondition=None
DistScoreCondAcceptTime=0.2
ScoreLossPerMiss=0.0
ScoreLossPerReload=0.0
MultSqrtAcc=false
EnableOverDamage=false
MapName=Apogee Shooting Stars Advanced.json
MapScale=4.0
BlockProjectilePredictors=true
BlockCheats=true
InvinciblePlayer=true
InvincibleBots=false
Timescale=1.0
BlockHealthbars=false
TimeRefilledByKill=0.0
BlockHitMarkers=false
BlockHitSounds=false
BlockMissSounds=false
BlockFCT=false
LockFOVRange=true
LockedFOVMin=103.0
LockedFOVMax=140.0
LockedFOVScale=Clamped Horizontal
EndChallengeAfterKills=0.0
EndChallengeAfterDamage=0.0
ForceParticleEffectsOn=false
IsTimeDilationActive=false
IsTargetSizeActive=false
IsHeightLocked=false
PerformanceMetricType=KillsPerSecond
TimeDilationType=TargetDilation
MaxTargetSizeMultiplier=2.0
MinTargetSizeMultiplier=0.1
MaxTargetSpeedMultiplier=5.0
MinTargetSpeedMultiplier=0.1
PerformanceTarget=0.5
PerformanceThreshold=0.01
TimeDilationBaseMultiplier=1.0
TargetSizeBaseMultiplier=1.0
AdjustmentRate=0.05
AdjustmentInterval=1.5
AimTypeTag=Clicking
AimSubTypeTag=Dynamic
AimTypeFlicking=false
AimTypeProjectile=false
AimTypePlayerMovement=false
DifficultyTag=3
SearchTags=Apogee, Apogee Season 2, Dynamic Clicking, Advanced
Description=Six targets running straight lanes back and forth. One click each.[nl][nl]Apogee Season 2, Dynamic Clicking, Advanced. Straight lines across the sky; lead nothing, match the line and click.
GameVersion=3.7.0
ScenarioVersion=Initial

[Aim Profile]
Name=Default
MinReactionTime=0.3
MaxReactionTime=0.4
MinSelfMovementCorrectionTime=0.001
MaxSelfMovementCorrectionTime=0.05
FlickFov=30.0
FlickSpeed=1.5
FlickError=15.0
TrackSpeed=3.5
TrackError=3.5
MaxTurnAngleFromPadCenter=75.0
MinReCenterTime=0.3
MaxReCenterTime=0.5
OptimalAimFov=30.0
OuterAimPenalty=1.0
MaxError=40.0
ShootFov=15.0
VerticalAimOffset=0.0
MaxTolerableSpread=5.0
MinTolerableSpread=1.0
TolerableSpreadDist=2000.0
MaxSpreadDistFactor=2.0
AimingStyle=Simple
ScanSpeedMultiplier=1.0
MaxSeekPitch=30.0
MaxSeekYaw=30.0
AimingSpeed=5.0
MinShootDelay=0.3
MaxShootDelay=0.6

[Bot Profile]
Name=Apogee Shooting Stars
DodgeProfileNames=Apogee Shooting Stars Move
DodgeProfileWeights=1.0
DodgeProfileMaxChangeTime=60.0
DodgeProfileMinChangeTime=60.0
WeaponsProfileNames=;;;;;;;
WeaponProfileWeights=1.0;1.0;1.0;1.0;1.0;1.0;1.0;1.0
AimingProfileNames=Default;Default;Default;Default;Default;Default;Default;Default
WeaponSwitchTime=3.0
UseWeapons=false
CharacterProfile=Apogee Shooting Stars Body
SeeThroughWalls=true
NoDodging=false
StandStillUntilHurt=false
NoAiming=false
SpawnGroup=0
AbilityUseTimer=1.0
UseAbilityFrequency=0.0
UseAbilityFreqMinTime=1.0
UseAbilityFreqMaxTime=1.0
ShowLaser=false
LaserRgb=X=1.000 Y=0.300 Z=0.000
LaserAlpha=1.0
RandomizeDodgeProfiles=false
RepeatDodgeProfileEntries=false
UseMinimumRespawnTime=true
DisableScoring=false
RestartDodgeProfileTimerOnRespawn=false
Untargetable=true

[Character Profile]
Name=Player
MaxHealth=1.0
WeaponProfileNames=BB Gun;;;;;;;
MinRespawnDelay=0.001
MaxRespawnDelay=0.001
StepUpHeight=0.0
CrouchHeightModifier=1.0
CrouchAnimationSpeed=1.0
CameraOffset=X=0.000 Y=0.000 Z=0.000
HeadshotOnly=false
DamageKnockbackFactor=0.0
MaxSpeed=0.0
MaxCrouchSpeed=0.0
Acceleration=0.0
CrouchingAcceleration=0.0
Friction=0.0
BrakingFrictionFactor=0.0
JumpVelocity=0.0
Gravity=0.0
AirControl=0.0
CanCrouch=false
CanPogoJump=false
CanCrouchInAir=false
CrouchInAirRaisesFeet=false
CanJumpFromCrouch=false
// Note: the color channel values are interpreted as 0.0 (0%) to 1.0 (100%) going over 1.0 will start to produce a glow effect when the user is in HDR mode (SceneColor is set to "Medium" or higher)
EnemyBodyColor=X=0.771 Y=0.000 Z=0.000
EnemyBodyColorOnHit=X=1.000 Y=1.000 Z=1.000
EnemyBodyColorOnLookAt=X=1.000 Y=1.000 Z=1.000
EnemyHeadColor=X=1.000 Y=1.000 Z=1.000
EnemyHeadColorOnHit=X=1.000 Y=1.000 Z=1.000
EnemyHeadColorOnLookAt=X=1.000 Y=1.000 Z=1.000
TeamBodyColor=X=1.000 Y=0.888 Z=0.000
TeamHeadColor=X=1.000 Y=1.000 Z=1.000
MainBBType=Spheroid
MainBBHeight=2.0
MainBBRadius=1.0
MainBBHasHead=false
MainBBHeadRadius=0.1
MainBBHeadOffset=0.0
MainBBHide=false
ProjBBType=Spheroid
ProjBBHeight=0.2
ProjBBRadius=0.1
ProjBBHasHead=false
ProjBBHeadRadius=0.1
ProjBBHeadOffset=0.1
ProjBBHide=true
BlockSelfDamage=false
InvinciblePlayer=false
InvincibleBots=false
BlockTeamDamage=false
HasJetpack=false
JetpackActivationDelay=0.2
JetpackFullFuelTime=4.0
JetpackFuelIncPerSec=1.0
JetpackFuelRegensInAir=false
JetpackThrust=6000.0
JetpackMaxZVelocity=400.0
JetpackAirControlWithThrust=0.25
AirJumpCount=0
AirJumpVelocity=0.0
AbilityProfileNames=
HideWeapon=true
AerialFriction=0.0
AerialVerticalTurningFriction=100000.0
AerialVerticalBreakingFriction=0.0
UseAerialVerticalFriction=false
StrafeSpeedMult=1.0
BackSpeedMult=1.0
RespawnInvulnTime=0.0
BlockedSpawnRadius=0.0
BlockSpawnFOV=5.0
BlockSpawnDistance=9999.0
RespawnAnimationDuration=0.0
AllowBufferedJumps=false
BounceOffWalls=false
LeanAngle=0.0
LeanDisplacement=0.0
AirJumpExtraControl=0.0
ForwardSpeedBias=1.0
HealthRegainedonkill=0.0
HealthRegenPerSec=0.0
HealthRegenDelay=0.0
JumpSpeedPenaltyDuration=0.0
JumpSpeedPenaltyPercent=0.0
ThirdPersonCamera=false
TPSArmLength=300.0
TPSOffset=X=0.000 Y=150.000 Z=150.000
BrakingDeceleration=0.0
TerminalVelocity=0.0
CharacterModel=None
CharacterSkin=Default
MeshHitDetection=false
SpawnOffsetMin=X=-0.000 Y=0.000 Z=-2.000
SpawnOffsetMax=X=-0.000 Y=0.000 Z=-2.000
InvertBlockedSpawn=false
ViewBobTime=0.0
ViewBobAngleAdjustment=0.0
ViewBobCameraZOffset=0.0
ViewBobAffectsShots=false
IsFlyer=false
FlightObeysPitch=false
FlightVelocityUp=800.0
FlightAccelUp=800.0
FlightVelocityDown=800.0
FlightAccelDown=800.0
IsFlyUpOnJumpAndCrouch=false
DisableCharacterCollision=false
LifeStealPercent=0.0
AbilityGlobalCooldown=0.0
BlockAbilityOnStartDuration=1.0
DragCoefficient=10.0
AmmoRegainedOnKill=0
ContinuousGroundFriction=0.0
ContinuousAirFriction=0.0
ScaledGroundAcceleration=0.0
ScaledAirAcceleration=0.0
MaxAirSpeed=0.0
StopSpeed=0.0
StopSpeedThreshold=0.0
ClampVelocityToInputSpeed=true
JumpSkipsFriction=false
EnableQuakeMovement=false
EnableQuakeJump=false
KtJump=0.0
MovementPhysicsTickInterval=0.0
MovementPhysicsTickEnabled=false
TeamGlowUpHead=0.0
TeamGlowUpBody=0.0
EnemyGlowUpHead=0.0
EnemyGlowUpBody=0.0
EnemyGlowUpHeadOnHit=0.0
EnemyGlowUpBodyOnHit=0.0
EnemyGlowUpHeadOnLookAt=0.0
EnemyGlowUpBodyOnLookAt=0.0
PlaybackOptions.PlaybackMode=Input
PlaybackOptions.OverrideRotation=true
PlaybackOptions.OverrideAbilities=true
PlaybackOptions.OverrideWeapons=true
PlaybackOptions.OverrideMovement=true
PlaybackOptions.OverrideDodgeTime=false
PlaybackOptions.LoopUponCompletion=true
PlaybackOptions.BreakToInputMode=false

[Character Profile]
Name=Apogee Shooting Stars Body
MaxHealth=1.0
WeaponProfileNames=;;;;;;;
MinRespawnDelay=0.001
MaxRespawnDelay=0.001
StepUpHeight=0.0
CrouchHeightModifier=0.5
CrouchAnimationSpeed=2.0
CameraOffset=X=0.000 Y=0.000 Z=0.000
HeadshotOnly=false
DamageKnockbackFactor=0.0
MaxSpeed=865.013103
MaxCrouchSpeed=500.0
Acceleration=100000.0
CrouchingAcceleration=800.0
Friction=100000.0
BrakingFrictionFactor=0.0
JumpVelocity=60.0
Gravity=0.0
AirControl=1.0
CanCrouch=false
CanPogoJump=false
CanCrouchInAir=false
CrouchInAirRaisesFeet=false
CanJumpFromCrouch=false
// Note: the color channel values are interpreted as 0.0 (0%) to 1.0 (100%) going over 1.0 will start to produce a glow effect when the user is in HDR mode (SceneColor is set to "Medium" or higher)
EnemyBodyColor=X=0.771 Y=0.000 Z=0.000
EnemyBodyColorOnHit=X=1.000 Y=1.000 Z=1.000
EnemyBodyColorOnLookAt=X=1.000 Y=1.000 Z=1.000
EnemyHeadColor=X=1.000 Y=1.000 Z=1.000
EnemyHeadColorOnHit=X=1.000 Y=1.000 Z=1.000
EnemyHeadColorOnLookAt=X=1.000 Y=1.000 Z=1.000
TeamBodyColor=X=1.000 Y=0.888 Z=0.000
TeamHeadColor=X=1.000 Y=1.000 Z=1.000
MainBBType=Spheroid
MainBBHeight=54.112934
MainBBRadius=27.056467
MainBBHasHead=false
MainBBHeadRadius=1.0
MainBBHeadOffset=0.0
MainBBHide=false
ProjBBType=Spheroid
ProjBBHeight=1.0
ProjBBRadius=1.0
ProjBBHasHead=false
ProjBBHeadRadius=1.0
ProjBBHeadOffset=1.0
ProjBBHide=true
BlockSelfDamage=false
InvinciblePlayer=false
InvincibleBots=false
BlockTeamDamage=false
HasJetpack=true
JetpackActivationDelay=0.001
JetpackFullFuelTime=9999.0
JetpackFuelIncPerSec=1000.0
JetpackFuelRegensInAir=false
JetpackThrust=160.0
JetpackMaxZVelocity=9999.0
JetpackAirControlWithThrust=1.0
AirJumpCount=0
AirJumpVelocity=0.0
AbilityProfileNames=;;;
HideWeapon=true
AerialFriction=0.0
AerialVerticalTurningFriction=100000.0
AerialVerticalBreakingFriction=0.0
UseAerialVerticalFriction=false
StrafeSpeedMult=1.0
BackSpeedMult=1.0
RespawnInvulnTime=0.0
BlockedSpawnRadius=600.0
BlockSpawnFOV=0.0
BlockSpawnDistance=0.0
RespawnAnimationDuration=0.0
AllowBufferedJumps=false
BounceOffWalls=false
LeanAngle=0.0
LeanDisplacement=0.0
AirJumpExtraControl=0.0
ForwardSpeedBias=0.4
HealthRegainedonkill=0.0
HealthRegenPerSec=0.0
HealthRegenDelay=0.0
JumpSpeedPenaltyDuration=0.0
JumpSpeedPenaltyPercent=0.0
ThirdPersonCamera=false
TPSArmLength=300.0
TPSOffset=X=0.000 Y=150.000 Z=150.000
BrakingDeceleration=0.0
TerminalVelocity=450.0
CharacterModel=None
CharacterSkin=Default
MeshHitDetection=false
SpawnOffsetMin=X=-300.000 Y=-300.000 Z=-100.000
SpawnOffsetMax=X=300.000 Y=300.000 Z=100.000
InvertBlockedSpawn=false
ViewBobTime=0.0
ViewBobAngleAdjustment=0.0
ViewBobCameraZOffset=0.0
ViewBobAffectsShots=false
IsFlyer=true
FlightObeysPitch=false
FlightVelocityUp=865.013103
FlightAccelUp=800.0
FlightVelocityDown=865.013103
FlightAccelDown=800.0
IsFlyUpOnJumpAndCrouch=false
DisableCharacterCollision=true
LifeStealPercent=0.0
AbilityGlobalCooldown=0.0
BlockAbilityOnStartDuration=1.0
DragCoefficient=1.0
AmmoRegainedOnKill=0
ContinuousGroundFriction=0.0
ContinuousAirFriction=0.0
ScaledGroundAcceleration=0.0
ScaledAirAcceleration=0.0
MaxAirSpeed=0.0
StopSpeed=0.0
StopSpeedThreshold=0.0
ClampVelocityToInputSpeed=true
JumpSkipsFriction=false
EnableQuakeMovement=false
EnableQuakeJump=false
KtJump=0.0
MovementPhysicsTickInterval=0.0
MovementPhysicsTickEnabled=false
TeamGlowUpHead=0.0
TeamGlowUpBody=0.0
EnemyGlowUpHead=0.0
EnemyGlowUpBody=0.0
EnemyGlowUpHeadOnHit=0.0
EnemyGlowUpBodyOnHit=0.0
EnemyGlowUpHeadOnLookAt=0.0
EnemyGlowUpBodyOnLookAt=0.0
PlaybackOptions.PlaybackMode=Input
PlaybackOptions.OverrideRotation=true
PlaybackOptions.OverrideAbilities=true
PlaybackOptions.OverrideWeapons=true
PlaybackOptions.OverrideMovement=true
PlaybackOptions.OverrideDodgeTime=false
PlaybackOptions.LoopUponCompletion=true
PlaybackOptions.BreakToInputMode=false

[Dodge Profile]
Name=Apogee Shooting Stars Move
MaxTargetDistance=100000.0
MinTargetDistance=1.0
ToggleLeftRight=false
ToggleForwardBack=false
MinLRTimeChange=0.5
MaxLRTimeChange=1.5
MinFBTimeChange=2.0
MaxFBTimeChange=3.0
DamageReactionChangesDirection=false
DamageReactionChanceToIgnore=0.5
DamageReactionMinimumDelay=0.125
DamageReactionMaximumDelay=0.25
DamageReactionCooldown=1.0
DamageReactionThreshold=50.0
DamageReactionResetTimer=0.5
JumpFrequency=0.0
CrouchInAirFrequency=0.0
CrouchOnGroundFrequency=0.0
TargetStrafeOverride=Ignore
TargetStrafeMinDelay=0.125
TargetStrafeMaxDelay=0.25
MinProfileChangeTime=0.3
MaxProfileChangeTime=0.3
MinCrouchTime=0.3
MaxCrouchTime=0.6
MinJumpTime=0.2
MaxJumpTime=1.0
AlterateJumpCrouchInput=true
ToggleUpDownMinTime=3.5
ToggleUpDownMaxTime=4.5
UpDownSwapPauseMinTime=0.0
UpDownSwapPauseMaxTime=0.0
LeftStrafeTimeMult=1.0
RightStrafeTimeMult=1.0
StrafeSwapMinPause=0.0
StrafeSwapMaxPause=0.0
BlockedMovementPercent=0.0
BlockedMovementReactionMin=0.0
BlockedMovementReactionMax=0.0
WaypointLogic=FollowAimAtTarget
WaypointTurnRate=100000.0
MinTimeBeforeShot=0.15
MaxTimeBeforeShot=0.25
IgnoreShotChance=0.0
ForwardTimeMult=1.0
BackTimeMult=1.0
DamageReactionChangesFB=false
CooldownTime=0.0
DamageReactionTriggersProfileChange=false
LOSReactType=None
LOSReactInitMin=0.175
LOSReactInitMax=0.25
LOSReactChanceIgnore=0.0
LOSReactCooldownTime=1.0
LOSReactDurationMin=1.0
LOSReactDurationMax=1.0
LOSReactKillBot=false
LOSReactKillBotTimerMin=0.5
LOSReactKillBotTimerMax=0.75
InitialForwardMovementState=Random
InitialRightMovementState=Random
CounterStrafeOnCollision=false
InitialLeftRightStrafeResetBehavior=EverySpawn
InitialForwardBackStrafeResetBehavior=EverySpawn
PlaybackOptions.PlaybackMode=Input
PlaybackOptions.OverrideRotation=true
PlaybackOptions.OverrideAbilities=true
PlaybackOptions.OverrideWeapons=true
PlaybackOptions.OverrideMovement=true
PlaybackOptions.OverrideDodgeTime=false
PlaybackOptions.LoopUponCompletion=true
PlaybackOptions.BreakToInputMode=false

[Weapon Profile]
Name=BB Gun
Type=Hitscan
ShotsPerClick=1
DamagePerShot=1.0
KnockbackFactor=0.0
TimeBetweenShots=0.1
Pierces=false
Category=SemiAuto
BurstShotCount=1
TimeBetweenBursts=0.5
ChargeStartDamage=10.0
ChargeStartVelocity=X=500.000 Y=0.000 Z=0.000
ChargeTimeToAutoRelease=2.0
ChargeTimeToCap=1.0
MuzzleVelocityMin=X=2000.000 Y=0.000 Z=0.000
MuzzleVelocityMax=X=2000.000 Y=0.000 Z=0.000
InheritOwnerVelocity=0.0
OriginOffset=X=0.000 Y=0.000 Z=0.000
MaxTravelTime=5.0
MaxHitscanRange=100000.0
GravityScale=1.0
HeadshotCapable=false
HeadshotMultiplier=1.0
CooldownType=InfiniteUse
MagazineMax=0
ReloadTimeFromEmpty=1.2
ReloadTimeFromPartial=1.2
CooldownTimer=0.8
MaxCharges=3
DamageFalloffStartDistance=100000.0
DamageFalloffStopDistance=100000.0
DamageAtMaxRange=1.0
DelayBeforeShot=0.0
ProjectileGraphic=Ball
VisualLifetime=0.1
Explosive=false
Radius=500.0
DamageAtCenter=100.0
DamageAtEdge=100.0
SelfDamageMultiplier=0.5
ExplodesOnContactWithEnemy=false
DelayAfterEnemyContact=0.0
ExplodesOnContactWithWorld=false
DelayAfterWorldContact=0.0
ExplodesOnNextAttack=false
DelayAfterSpawn=0.0
BlockedByWorld=false
ClearAttackersOnSelfDmg=false
BounceOffWorld=false
BounceFactor=0.5
BounceCount=0
HomingProjectileAcceleration=0.0
SpreadSSA=1.0,1.0,-1.0,5.0
SpreadSCA=1.0,1.0,-1.0,5.0
SpreadMSA=1.0,1.0,-1.0,5.0
SpreadMCA=1.0,1.0,-1.0,5.0
SpreadSSH=0.0,0.1,0.0,0.0
SpreadSCH=1.0,1.0,-1.0,5.0
SpreadMSH=0.0,0.1,0.0,0.0
SpreadMCH=1.0,1.0,-1.0,5.0
MaxRecoilUp=0.0
MinRecoilUp=0.0
MinRecoilHoriz=0.0
MaxRecoilHoriz=0.0
FirstShotRecoilMult=1.0
RecoilAutoReset=false
TimeToRecoilPeak=0.05
TimeToRecoilReset=0.35
ProjectileWorldHitRadius=0.0
ProjectileEnemyHitRadius=1.0
CanAimDownSight=false
ADSZoomSensFactor=0.7
ADSMoveFactor=1.0
ADSStartDelay=0.0
AAMode=0
AAPreferClosestPlayer=true
AAAlpha=1.0
AAMaxSpeed=360.0
AADeadZone=0.0
AAFOV=360.0
AANeedsLOS=true
TrackHorizontal=true
TrackVertical=true
AABlocksMouse=false
AAOffTimer=0.0
AABackOnTimer=0.0
TriggerBotEnabled=false
TriggerBotDelay=0.0
TriggerBotFOV=1.0
StickyLock=false
HeadLock=false
VerticalOffset=0.0
DisableLockOnKill=false
ShootSoundCooldown=0.08
HitSoundCooldown=0.08
ShootSound=Shot
HitscanVisualOffset=X=0.000 Y=0.000 Z=-50.000
ADSBlocksShooting=false
ShootingBlocksADS=false
KnockbackFactorAir=0.0
RecoilNegatable=false
DecalType=1
DecalSize=30.0
DelayAfterShooting=0.0
BeamTracksCrosshair=false
AlsoShoot=
ADSShoot=
ChargeMoveSpeedModifier=1.0
StunDuration=0.0
AmmoPerShot=20
UsePerShotRecoil=false
PSRLoopStartIndex=0
PSRViewRecoilTracking=0.45
PSRCapUp=9.0
PSRCapRight=4.0
PSRCapLeft=4.0
PSRTimeToPeak=0.175
PSRResetDegreesPerSec=40.0
CircularSpread=true
SpreadStationaryVelocity=0.0
PassiveCharging=false
BurstFullyAuto=true
FlatKnockbackHorizontal=0.0
FlatKnockbackVertical=0.0
HitscanRadius=0.0
HitscanVisualRadius=6.0
TaggingDuration=0.0
TaggingMaxFactor=1.0
TaggingHitFactor=1.0
RecoilCrouchScale=1.0
RecoilADSScale=1.0
PSRCrouchScale=1.0
PSRADSScale=1.0
ProjectileAcceleration=0.0
AccelIncludeVertical=false
AimPunchAmount=0.0
AimPunchResetTime=0.05
AimPunchCooldown=0.5
AimPunchHeadshotOnly=false
AimPunchCosmeticOnly=false
MinimumDecelVelocity=0.0
PSRManualNegation=false
PSRAutoReset=true
UsePerBulletSpread=false
PBS0=0.0,0.0
AimPunchUpTime=0.05
AmmoReloadedOnKill=25
CancelReloadOnKill=false
FlatKnockbackHorizontalMin=0.0
FlatKnockbackVerticalMin=0.0
ADSScope=No Scope
ADSFOVOverride=72.099998
ADSAllowUserOverrideFOV=true
HitscanGraphicOriginAtWeapon=false
ProjectileGraphicOriginAtWeapon=false
IsChargeWeapon=false
IsBurstWeapon=false
ForceFirstPersonInADS=true
ZoomBlockedInAir=false
ADSCameraOffsetX=0.0
ADSCameraOffsetY=0.0
ADSCameraOffsetZ=0.0
QuickSwitchTime=0.0
WeaponModel=Heavy Surge Rifle
WeaponAnimation=Primary
UseIncReload=false
IncReloadStartupTime=0.0
IncReloadLoopTime=0.0
IncReloadAmmoPerLoop=1
IncReloadEndTime=0.0
IncReloadCancelWithShoot=true
WeaponSkin=Default
ProjectileVisualOffset=X=0.000 Y=0.000 Z=0.000
SpreadDecayDelay=0.0
ReloadBeforeRecovery=true
3rdPersonWeaponModel=Pistol
3rdPersonWeaponSkin=Default
ParticleMuzzleFlash=None
ParticleWallImpact=None
ParticleBodyImpact=Flare
ParticleProjectileTrail=None
ParticleHitscanTrace=None
ParticleMuzzleFlashScale=1.0
ParticleWallImpactScale=1.0
ParticleBodyImpactScale=1.0
ParticleProjectileTrailScale=1.0
ADSFOVScale=Overwatch
ADSCustomFOVAspectX=16
ADSCustomFOVAspectY=9
ADSCustomFOVScale=hML
ADSResetsCharge=true
ADSZoomInDuration=0.0
ADSZoomOutDuration=0.0
ADSFOVScaleString=Quake/Source
FullyAutomatic=false
DelayBeforePassiveCharge=0.0
BaseChargeRecoilFactor=0.0
AccelSpeedModifier=1.0
MaxSpeedModifier=1.0

[Map Data]
{
    "materialSets": [
        {
            "ceiling": {
                "material": "MI_WA_MarblePolished",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "858585ff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 1
                    },
                    {
                        "name": "Metallic",
                        "value": 1
                    },
                    {
                        "name": "FullBright",
                        "value": 0.800000011920929
                    }
                ]
            },
            "ground": {
                "material": "MI_WA_MarblePolished",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "7a7a7aff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 1
                    },
                    {
                        "name": "Metallic",
                        "value": 1
                    },
                    {
                        "name": "FullBright",
                        "value": 0.7962962985038757
                    }
                ]
            },
            "ramp": {
                "material": "MI_WA_ConcretePoured",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "7a7a7aff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 1
                    },
                    {
                        "name": "Metallic",
                        "value": 1
                    },
                    {
                        "name": "FullBright",
                        "value": 0.8008474707603455
                    }
                ]
            },
            "wall": {
                "material": "MI_WA_ConcretePoured",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "b1b1b1ff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 1
                    },
                    {
                        "name": "Metallic",
                        "value": 1
                    },
                    {
                        "name": "FullBright",
                        "value": 0.7962962985038757
                    }
                ]
            }
        },
        {
            "ceiling": {
                "material": "MI_WA_SciFiPanelBDark",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "ffffffff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 0
                    },
                    {
                        "name": "Metallic",
                        "value": 0
                    },
                    {
                        "name": "FullBright",
                        "value": 0
                    }
                ]
            },
            "ground": {
                "material": "MI_WA_SciFiFloorC",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "ffffffff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 0
                    },
                    {
                        "name": "Metallic",
                        "value": 0
                    },
                    {
                        "name": "FullBright",
                        "value": 0
                    }
                ]
            },
            "ramp": {
                "material": "MI_WA_SciFiCeilingA",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "ffffffff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 0.5
                    },
                    {
                        "name": "Metallic",
                        "value": 0.5
                    },
                    {
                        "name": "FullBright",
                        "value": 0
                    }
                ]
            },
            "wall": {
                "material": "MI_WA_SciFiWallD",
                "pack": "Default",
                "properties": [
                    {
                        "name": "Tint",
                        "value": "ffffffff"
                    },
                    {
                        "name": "Scale",
                        "value": 1
                    },
                    {
                        "name": "Roughness",
                        "value": 0
                    },
                    {
                        "name": "Metallic",
                        "value": 0
                    },
                    {
                        "name": "FullBright",
                        "value": 0
                    }
                ]
            }
        },
        {
            "ceiling": {
                "material": "None",
                "pack": "None"
            },
            "ground": {
                "material": "None",
                "pack": "None"
            },
            "ramp": {
                "material": "None",
                "pack": "None"
            },
            "wall": {
                "material": "None",
                "pack": "None"
            }
        }
    ],
    "objects": [
        {
            "location": "-1088.000000, -1388.871804, -1255.458797",
            "materialSets": [
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                }
            ],
            "mesh": "Cube",
            "name": "Default",
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "25.901145, 10.240000, 25.101497",
            "type": "brush"
        },
        {
            "location": "-1088.000000, 364.849078, -1255.458797",
            "materialSets": [
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                }
            ],
            "mesh": "Cube",
            "name": "Default",
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "25.901145, 10.240000, 25.101497",
            "type": "brush"
        },
        {
            "location": "-1088.000000, -1388.871804, -1255.458797",
            "materialSets": [
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                }
            ],
            "mesh": "Cube",
            "name": "Default",
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "10.240000, 27.777209, 25.101497",
            "type": "brush"
        },
        {
            "location": "478.114512, -1388.871804, -1255.458797",
            "materialSets": [
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                }
            ],
            "mesh": "Cube",
            "name": "Default",
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "10.240000, 27.777209, 25.101497",
            "type": "brush"
        },
        {
            "location": "-1088.000000, -1388.871804, -1255.458797",
            "materialSets": [
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                }
            ],
            "mesh": "Cube",
            "name": "Default",
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "25.901145, 27.777209, 10.240000",
            "type": "brush"
        },
        {
            "location": "-1088.000000, -1388.871804, 230.690895",
            "materialSets": [
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                },
                {
                    "group": 0,
                    "surface": "ground"
                }
            ],
            "mesh": "Cube",
            "name": "Default",
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "25.901145, 27.777209, 10.240000",
            "type": "brush"
        },
        {
            "location": "0.000000, 0.000000, 0.000000",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 1
                },
                {
                    "name": "Path",
                    "value": ""
                },
                {
                    "name": "LoopingPath",
                    "value": false
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "398.170649, -289.287910, -141.126326",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 1-1,Shooting Stars 1-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "403.452003, 293.125038, -115.966345",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 2-1,Shooting Stars 2-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.693514, -296.206677, -90.507476",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 3-1,Shooting Stars 3-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "410.884250, 298.524882, -64.815336",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 4-1,Shooting Stars 4-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "413.015987, -300.073680, -38.956144",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 5-1,Shooting Stars 5-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.083231, 300.849078, -12.996547",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 6-1,Shooting Stars 6-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.083231, -300.849078, 12.996547",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 7-1,Shooting Stars 7-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "413.015987, 300.073680, 38.956144",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 8-1,Shooting Stars 8-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "410.884250, -298.524882, 64.815336",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 9-1,Shooting Stars 9-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.693514, 296.206677, 90.507476",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 10-1,Shooting Stars 10-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "403.452003, -293.125038, 115.966345",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 11-1,Shooting Stars 11-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "398.170649, 289.287910, 141.126326",
            "name": "SpawnPoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "SpawnPoint1"
                },
                {
                    "name": "TeamMask",
                    "value": 2
                },
                {
                    "name": "Path",
                    "value": "Shooting Stars 12-1,Shooting Stars 12-2"
                },
                {
                    "name": "LoopingPath",
                    "value": true
                },
                {
                    "name": "PermittedCharacterProfiles",
                    "value": ""
                },
                {
                    "name": "Weight",
                    "value": 1
                }
            ],
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "398.170649, -289.287910, -141.126326",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 1-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.923819, 296.374002, -88.907867",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 1-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "403.452003, 293.125038, -115.966345",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 2-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "391.435122, -284.394263, -167.458797",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 2-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.693514, -296.206677, -90.507476",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 3-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "410.966932, 298.584954, -64.009419",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 3-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "410.884250, 298.524882, -64.815336",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 4-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.114512, -300.871804, -11.372265",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 4-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "413.015987, -300.073680, -38.956144",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 5-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.459104, 296.036368, -92.106174",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 5-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.083231, 300.849078, -12.996547",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 6-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.066027, -300.836578, 13.808640",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 6-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.083231, -300.849078, 12.996547",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 7-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "410.715783, 298.402483, 66.426679",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 7-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "413.015987, 300.073680, 38.956144",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 8-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "414.047781, -300.823321, -14.620698",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 8-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "410.884250, -298.524882, 64.815336",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 9-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.576822, 296.121895, 91.306940",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 9-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "407.693514, 296.206677, 90.507476",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 10-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "397.806334, -289.023220, 142.687416",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 10-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "403.452003, -293.125038, 115.966345",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 11-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "411.048580, 298.644274, 63.203341",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 11-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "398.170649, 289.287910, 141.126326",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 12-1"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "391.649585, -284.550080, 166.690895",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Shooting Stars 12-2"
                },
                {
                    "name": "BotPauseTimeMin",
                    "value": 0
                },
                {
                    "name": "BotPauseTimeMax",
                    "value": 0
                }
            ],
            "rotation": "0.000000, 0.000000, 0.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        }
    ],
    "version": "1.0.0"
}