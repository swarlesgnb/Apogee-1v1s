Name=Apogee Gravity Well Advanced
PlayerCharacters=Player
BotCharacters=Apogee Gravity Well.bot
IsChallenge=true
OvershotProtectionTimer=0.0
Timelimit=60.0
PlayerProfile=Player
AddedBots=Apogee Gravity Well.bot;Apogee Gravity Well.bot;Apogee Gravity Well.bot;Apogee Gravity Well.bot;Apogee Gravity Well.bot;Apogee Gravity Well.bot
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
MapName=Apogee Gravity Well Advanced.json
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
Description=Targets spiral in from a ring toward the centre. One click each.[nl][nl]Apogee Season 2, Dynamic Clicking, Advanced. They spiral in from the rim; catch them before they reach the middle.
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
Name=Apogee Gravity Well
DodgeProfileNames=Apogee Gravity Well Move
DodgeProfileWeights=1.0
DodgeProfileMaxChangeTime=60.0
DodgeProfileMinChangeTime=60.0
WeaponsProfileNames=;;;;;;;
WeaponProfileWeights=1.0;1.0;1.0;1.0;1.0;1.0;1.0;1.0
AimingProfileNames=Default;Default;Default;Default;Default;Default;Default;Default
WeaponSwitchTime=3.0
UseWeapons=false
CharacterProfile=Apogee Gravity Well Body
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
Name=Apogee Gravity Well Body
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
MaxSpeed=605.509172
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
FlightVelocityUp=605.509172
FlightAccelUp=800.0
FlightVelocityDown=605.509172
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
Name=Apogee Gravity Well Move
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
            "location": "-1088.000000, -1296.249161, -1296.249161",
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
            "scale": "26.872984, 10.240000, 25.924983",
            "type": "brush"
        },
        {
            "location": "-1088.000000, 272.249161, -1296.249161",
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
            "scale": "26.872984, 10.240000, 25.924983",
            "type": "brush"
        },
        {
            "location": "-1088.000000, -1296.249161, -1296.249161",
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
            "scale": "10.240000, 25.924983, 25.924983",
            "type": "brush"
        },
        {
            "location": "575.298442, -1296.249161, -1296.249161",
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
            "scale": "10.240000, 25.924983, 25.924983",
            "type": "brush"
        },
        {
            "location": "-1088.000000, -1296.249161, -1296.249161",
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
            "scale": "26.872984, 25.924983, 10.240000",
            "type": "brush"
        },
        {
            "location": "-1088.000000, -1296.249161, 272.249161",
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
            "scale": "26.872984, 25.924983, 10.240000",
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
            "location": "467.735274, 208.249161, 0.000000",
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
                    "value": "Gravity Well 1-1,Gravity Well 1-2,Gravity Well 1-3,Gravity Well 1-4,Gravity Well 1-5,Gravity Well 1-6,Gravity Well 1-7,Gravity Well 1-8,Gravity Well 1-9,Gravity Well 1-10,Gravity Well 1-11,Gravity Well 1-12,Gravity Well 1-13,Gravity Well 1-14,Gravity Well 1-15,Gravity Well 1-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, 177.715913, 106.450786",
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
                    "value": "Gravity Well 2-1,Gravity Well 2-2,Gravity Well 2-3,Gravity Well 2-4,Gravity Well 2-5,Gravity Well 2-6,Gravity Well 2-7,Gravity Well 2-8,Gravity Well 2-9,Gravity Well 2-10,Gravity Well 2-11,Gravity Well 2-12,Gravity Well 2-13,Gravity Well 2-14,Gravity Well 2-15,Gravity Well 2-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, 99.523078, 181.686192",
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
                    "value": "Gravity Well 3-1,Gravity Well 3-2,Gravity Well 3-3,Gravity Well 3-4,Gravity Well 3-5,Gravity Well 3-6,Gravity Well 3-7,Gravity Well 3-8,Gravity Well 3-9,Gravity Well 3-10,Gravity Well 3-11,Gravity Well 3-12,Gravity Well 3-13,Gravity Well 3-14,Gravity Well 3-15,Gravity Well 3-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "467.735274, 0.000000, 208.249161",
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
                    "value": "Gravity Well 4-1,Gravity Well 4-2,Gravity Well 4-3,Gravity Well 4-4,Gravity Well 4-5,Gravity Well 4-6,Gravity Well 4-7,Gravity Well 4-8,Gravity Well 4-9,Gravity Well 4-10,Gravity Well 4-11,Gravity Well 4-12,Gravity Well 4-13,Gravity Well 4-14,Gravity Well 4-15,Gravity Well 4-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, -99.523078, 181.686192",
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
                    "value": "Gravity Well 5-1,Gravity Well 5-2,Gravity Well 5-3,Gravity Well 5-4,Gravity Well 5-5,Gravity Well 5-6,Gravity Well 5-7,Gravity Well 5-8,Gravity Well 5-9,Gravity Well 5-10,Gravity Well 5-11,Gravity Well 5-12,Gravity Well 5-13,Gravity Well 5-14,Gravity Well 5-15,Gravity Well 5-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, -177.715913, 106.450786",
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
                    "value": "Gravity Well 6-1,Gravity Well 6-2,Gravity Well 6-3,Gravity Well 6-4,Gravity Well 6-5,Gravity Well 6-6,Gravity Well 6-7,Gravity Well 6-8,Gravity Well 6-9,Gravity Well 6-10,Gravity Well 6-11,Gravity Well 6-12,Gravity Well 6-13,Gravity Well 6-14,Gravity Well 6-15,Gravity Well 6-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "467.735274, -208.249161, 0.000000",
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
                    "value": "Gravity Well 7-1,Gravity Well 7-2,Gravity Well 7-3,Gravity Well 7-4,Gravity Well 7-5,Gravity Well 7-6,Gravity Well 7-7,Gravity Well 7-8,Gravity Well 7-9,Gravity Well 7-10,Gravity Well 7-11,Gravity Well 7-12,Gravity Well 7-13,Gravity Well 7-14,Gravity Well 7-15,Gravity Well 7-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, -177.715913, -106.450786",
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
                    "value": "Gravity Well 8-1,Gravity Well 8-2,Gravity Well 8-3,Gravity Well 8-4,Gravity Well 8-5,Gravity Well 8-6,Gravity Well 8-7,Gravity Well 8-8,Gravity Well 8-9,Gravity Well 8-10,Gravity Well 8-11,Gravity Well 8-12,Gravity Well 8-13,Gravity Well 8-14,Gravity Well 8-15,Gravity Well 8-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, -99.523078, -181.686192",
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
                    "value": "Gravity Well 9-1,Gravity Well 9-2,Gravity Well 9-3,Gravity Well 9-4,Gravity Well 9-5,Gravity Well 9-6,Gravity Well 9-7,Gravity Well 9-8,Gravity Well 9-9,Gravity Well 9-10,Gravity Well 9-11,Gravity Well 9-12,Gravity Well 9-13,Gravity Well 9-14,Gravity Well 9-15,Gravity Well 9-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "467.735274, -0.000000, -208.249161",
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
                    "value": "Gravity Well 10-1,Gravity Well 10-2,Gravity Well 10-3,Gravity Well 10-4,Gravity Well 10-5,Gravity Well 10-6,Gravity Well 10-7,Gravity Well 10-8,Gravity Well 10-9,Gravity Well 10-10,Gravity Well 10-11,Gravity Well 10-12,Gravity Well 10-13,Gravity Well 10-14,Gravity Well 10-15,Gravity Well 10-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, 99.523078, -181.686192",
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
                    "value": "Gravity Well 11-1,Gravity Well 11-2,Gravity Well 11-3,Gravity Well 11-4,Gravity Well 11-5,Gravity Well 11-6,Gravity Well 11-7,Gravity Well 11-8,Gravity Well 11-9,Gravity Well 11-10,Gravity Well 11-11,Gravity Well 11-12,Gravity Well 11-13,Gravity Well 11-14,Gravity Well 11-15,Gravity Well 11-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "468.219270, 177.715913, -106.450786",
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
                    "value": "Gravity Well 12-1,Gravity Well 12-2,Gravity Well 12-3,Gravity Well 12-4,Gravity Well 12-5,Gravity Well 12-6,Gravity Well 12-7,Gravity Well 12-8,Gravity Well 12-9,Gravity Well 12-10,Gravity Well 12-11,Gravity Well 12-12,Gravity Well 12-13,Gravity Well 12-14,Gravity Well 12-15,Gravity Well 12-16"
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
            "rotation": "0.000000, 0.000000, 180.000000",
            "scale": "0.250000, 0.250000, 0.250000",
            "type": "gameObject"
        },
        {
            "location": "467.735274, 208.249161, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-1"
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
            "location": "473.064957, 168.192022, 100.324426",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-2"
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
            "location": "477.645600, 89.388944, 161.270881",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-3"
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
            "location": "481.730954, 0.000000, 173.433815",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-4"
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
            "location": "485.992947, -78.713682, 140.566752",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-5"
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
            "location": "489.750948, -128.688716, 75.678418",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-6"
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
            "location": "493.139234, -137.686948, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-7"
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
            "location": "496.416014, -108.214056, -63.283956",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-8"
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
            "location": "499.316125, -56.007277, -98.440807",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-9"
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
            "location": "501.898841, -0.000000, -101.200558",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-10"
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
            "location": "504.236371, 44.114966, -77.094435",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-11"
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
            "location": "506.251370, 66.180259, -38.389108",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-12"
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
            "location": "507.962727, 64.170616, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-13"
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
            "location": "509.380601, 44.770607, 25.903585",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-14"
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
            "location": "510.491565, 19.611108, 34.025964",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-15"
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
            "location": "511.298322, 0.000000, 26.796010",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 1-16"
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
            "location": "468.219270, 177.715913, 106.450786",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-1"
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
            "location": "473.064957, 94.527706, 171.516937",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-2"
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
            "location": "477.349786, 0.000000, 185.151780",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-3"
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
            "location": "481.956428, -84.114862, 150.952612",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-4"
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
            "location": "485.992947, -138.758538, 81.859168",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-5"
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
            "location": "489.628035, -149.694313, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-6"
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
            "location": "493.226512, -118.504225, -69.486373",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-7"
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
            "location": "496.416014, -61.831883, -109.050261",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-8"
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
            "location": "499.276469, -0.000000, -113.432831",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-9"
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
            "location": "501.923818, 50.098657, -87.787275",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-10"
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
            "location": "504.236371, 76.801067, -44.623740",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-11"
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
            "location": "506.243267, 76.562096, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-12"
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
            "location": "507.966711, 55.500261, 32.148746",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-13"
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
            "location": "509.380601, 25.804108, 44.828016",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-14"
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
            "location": "510.491009, 0.000000, 39.280142",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-15"
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
            "location": "511.298442, -13.388821, 23.208676",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 2-16"
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
            "location": "468.219270, 99.523078, 181.686192",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-1"
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
            "location": "472.683631, 0.000000, 196.759205",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-2"
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
            "location": "477.645600, -89.388944, 161.270881",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-3"
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
            "location": "481.956428, -148.704826, 88.027699",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-4"
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
            "location": "485.824518, -161.612307, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-5"
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
            "location": "489.750948, -128.688716, -75.678418",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-6"
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
            "location": "493.226512, -67.563628, -119.610884",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-7"
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
            "location": "496.356019, -0.000000, -125.597382",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-8"
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
            "location": "499.316125, 56.007277, -98.440807",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-9"
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
            "location": "501.923818, 87.353217, -50.851712",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-10"
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
            "location": "504.221570, 88.907867, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-11"
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
            "location": "506.251370, 66.180259, 38.389108",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-12"
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
            "location": "507.966711, 31.958557, 55.609995",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-13"
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
            "location": "509.378923, 0.000000, 51.740824",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-14"
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
            "location": "510.491565, -19.611108, 34.025964",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-15"
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
            "location": "511.298442, -23.200723, 13.402598",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 3-16"
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
            "location": "467.735274, 0.000000, 208.249161",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-1"
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
            "location": "473.064957, -94.527706, 171.516937",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-2"
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
            "location": "477.645600, -158.518849, 94.183092",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-3"
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
            "location": "481.730954, -173.433815, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-4"
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
            "location": "485.992947, -138.758538, -81.859168",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-5"
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
            "location": "489.750948, -73.193770, -130.117949",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-6"
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
            "location": "493.139234, -0.000000, -137.686948",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-7"
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
            "location": "496.416014, 61.831883, -109.050261",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-8"
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
            "location": "499.316125, 97.827316, -57.072093",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-9"
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
            "location": "501.898841, 101.200558, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-10"
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
            "location": "504.236371, 76.801067, 44.623740",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-11"
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
            "location": "506.251370, 38.065232, 66.367073",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-12"
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
            "location": "507.962727, 0.000000, 64.170616",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-13"
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
            "location": "509.380601, -25.804108, 44.828016",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-14"
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
            "location": "510.491565, -34.000884, 19.654558",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-15"
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
            "location": "511.298322, -26.796010, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 4-16"
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
            "location": "468.219270, -99.523078, 181.686192",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-1"
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
            "location": "473.064957, -168.192022, 100.324426",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-2"
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
            "location": "477.349786, -185.151780, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-3"
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
            "location": "481.956428, -148.704826, -88.027699",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-4"
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
            "location": "485.992947, -78.713682, -140.566752",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-5"
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
            "location": "489.628035, -0.000000, -149.694313",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-6"
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
            "location": "493.226512, 67.563628, -119.610884",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-7"
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
            "location": "496.416014, 108.214056, -63.283956",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-8"
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
            "location": "499.276469, 113.432831, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-9"
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
            "location": "501.923818, 87.353217, 50.851712",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-10"
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
            "location": "504.236371, 44.114966, 77.094435",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-11"
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
            "location": "506.243267, 0.000000, 76.562096",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-12"
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
            "location": "507.966711, -31.958557, 55.609995",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-13"
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
            "location": "509.380601, -44.770607, 25.903585",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-14"
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
            "location": "510.491009, -39.280142, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-15"
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
            "location": "511.298442, -23.200723, -13.402598",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 5-16"
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
            "location": "468.219270, -177.715913, 106.450786",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-1"
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
            "location": "472.683631, -196.759205, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-2"
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
            "location": "477.645600, -158.518849, -94.183092",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-3"
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
            "location": "481.956428, -84.114862, -150.952612",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-4"
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
            "location": "485.824518, -0.000000, -161.612307",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-5"
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
            "location": "489.750948, 73.193770, -130.117949",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-6"
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
            "location": "493.226512, 118.504225, -69.486373",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-7"
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
            "location": "496.356019, 125.597382, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-8"
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
            "location": "499.316125, 97.827316, 57.072093",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-9"
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
            "location": "501.923818, 50.098657, 87.787275",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-10"
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
            "location": "504.221570, 0.000000, 88.907867",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-11"
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
            "location": "506.251370, -38.065232, 66.367073",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-12"
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
            "location": "507.966711, -55.500261, 32.148746",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-13"
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
            "location": "509.378923, -51.740824, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-14"
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
            "location": "510.491565, -34.000884, -19.654558",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-15"
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
            "location": "511.298442, -13.388821, -23.208676",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 6-16"
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
            "location": "467.735274, -208.249161, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-1"
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
            "location": "473.064957, -168.192022, -100.324426",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-2"
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
            "location": "477.645600, -89.388944, -161.270881",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-3"
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
            "location": "481.730954, -0.000000, -173.433815",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-4"
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
            "location": "485.992947, 78.713682, -140.566752",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-5"
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
            "location": "489.750948, 128.688716, -75.678418",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-6"
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
            "location": "493.139234, 137.686948, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-7"
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
            "location": "496.416014, 108.214056, 63.283956",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-8"
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
            "location": "499.316125, 56.007277, 98.440807",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-9"
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
            "location": "501.898841, 0.000000, 101.200558",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-10"
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
            "location": "504.236371, -44.114966, 77.094435",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-11"
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
            "location": "506.251370, -66.180259, 38.389108",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-12"
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
            "location": "507.962727, -64.170616, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-13"
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
            "location": "509.380601, -44.770607, -25.903585",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-14"
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
            "location": "510.491565, -19.611108, -34.025964",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-15"
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
            "location": "511.298322, -0.000000, -26.796010",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 7-16"
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
            "location": "468.219270, -177.715913, -106.450786",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-1"
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
            "location": "473.064957, -94.527706, -171.516937",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-2"
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
            "location": "477.349786, -0.000000, -185.151780",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-3"
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
            "location": "481.956428, 84.114862, -150.952612",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-4"
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
            "location": "485.992947, 138.758538, -81.859168",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-5"
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
            "location": "489.628035, 149.694313, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-6"
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
            "location": "493.226512, 118.504225, 69.486373",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-7"
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
            "location": "496.416014, 61.831883, 109.050261",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-8"
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
            "location": "499.276469, 0.000000, 113.432831",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-9"
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
            "location": "501.923818, -50.098657, 87.787275",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-10"
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
            "location": "504.236371, -76.801067, 44.623740",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-11"
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
            "location": "506.243267, -76.562096, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-12"
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
            "location": "507.966711, -55.500261, -32.148746",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-13"
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
            "location": "509.380601, -25.804108, -44.828016",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-14"
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
            "location": "510.491009, -0.000000, -39.280142",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-15"
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
            "location": "511.298442, 13.388821, -23.208676",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 8-16"
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
            "location": "468.219270, -99.523078, -181.686192",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-1"
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
            "location": "472.683631, -0.000000, -196.759205",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-2"
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
            "location": "477.645600, 89.388944, -161.270881",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-3"
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
            "location": "481.956428, 148.704826, -88.027699",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-4"
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
            "location": "485.824518, 161.612307, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-5"
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
            "location": "489.750948, 128.688716, 75.678418",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-6"
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
            "location": "493.226512, 67.563628, 119.610884",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-7"
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
            "location": "496.356019, 0.000000, 125.597382",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-8"
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
            "location": "499.316125, -56.007277, 98.440807",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-9"
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
            "location": "501.923818, -87.353217, 50.851712",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-10"
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
            "location": "504.221570, -88.907867, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-11"
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
            "location": "506.251370, -66.180259, -38.389108",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-12"
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
            "location": "507.966711, -31.958557, -55.609995",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-13"
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
            "location": "509.378923, -0.000000, -51.740824",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-14"
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
            "location": "510.491565, 19.611108, -34.025964",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-15"
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
            "location": "511.298442, 23.200723, -13.402598",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 9-16"
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
            "location": "467.735274, -0.000000, -208.249161",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-1"
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
            "location": "473.064957, 94.527706, -171.516937",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-2"
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
            "location": "477.645600, 158.518849, -94.183092",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-3"
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
            "location": "481.730954, 173.433815, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-4"
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
            "location": "485.992947, 138.758538, 81.859168",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-5"
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
            "location": "489.750948, 73.193770, 130.117949",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-6"
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
            "location": "493.139234, 0.000000, 137.686948",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-7"
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
            "location": "496.416014, -61.831883, 109.050261",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-8"
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
            "location": "499.316125, -97.827316, 57.072093",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-9"
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
            "location": "501.898841, -101.200558, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-10"
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
            "location": "504.236371, -76.801067, -44.623740",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-11"
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
            "location": "506.251370, -38.065232, -66.367073",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-12"
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
            "location": "507.962727, -0.000000, -64.170616",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-13"
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
            "location": "509.380601, 25.804108, -44.828016",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-14"
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
            "location": "510.491565, 34.000884, -19.654558",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-15"
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
            "location": "511.298322, 26.796010, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 10-16"
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
            "location": "468.219270, 99.523078, -181.686192",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-1"
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
            "location": "473.064957, 168.192022, -100.324426",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-2"
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
            "location": "477.349786, 185.151780, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-3"
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
            "location": "481.956428, 148.704826, 88.027699",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-4"
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
            "location": "485.992947, 78.713682, 140.566752",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-5"
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
            "location": "489.628035, 0.000000, 149.694313",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-6"
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
            "location": "493.226512, -67.563628, 119.610884",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-7"
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
            "location": "496.416014, -108.214056, 63.283956",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-8"
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
            "location": "499.276469, -113.432831, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-9"
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
            "location": "501.923818, -87.353217, -50.851712",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-10"
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
            "location": "504.236371, -44.114966, -77.094435",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-11"
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
            "location": "506.243267, -0.000000, -76.562096",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-12"
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
            "location": "507.966711, 31.958557, -55.609995",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-13"
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
            "location": "509.380601, 44.770607, -25.903585",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-14"
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
            "location": "510.491009, 39.280142, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-15"
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
            "location": "511.298442, 23.200723, 13.402598",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 11-16"
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
            "location": "468.219270, 177.715913, -106.450786",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-1"
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
            "location": "472.683631, 196.759205, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-2"
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
            "location": "477.645600, 158.518849, 94.183092",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-3"
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
            "location": "481.956428, 84.114862, 150.952612",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-4"
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
            "location": "485.824518, 0.000000, 161.612307",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-5"
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
            "location": "489.750948, -73.193770, 130.117949",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-6"
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
            "location": "493.226512, -118.504225, 69.486373",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-7"
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
            "location": "496.356019, -125.597382, 0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-8"
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
            "location": "499.316125, -97.827316, -57.072093",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-9"
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
            "location": "501.923818, -50.098657, -87.787275",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-10"
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
            "location": "504.221570, -0.000000, -88.907867",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-11"
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
            "location": "506.251370, 38.065232, -66.367073",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-12"
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
            "location": "507.966711, 55.500261, -32.148746",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-13"
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
            "location": "509.378923, 51.740824, -0.000000",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-14"
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
            "location": "510.491565, 34.000884, 19.654558",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-15"
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
            "location": "511.298442, 13.388821, 23.208676",
            "name": "Waypoint",
            "properties": [
                {
                    "name": "Name",
                    "value": "Gravity Well 12-16"
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