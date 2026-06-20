import { profileIcons, defaultProfileIconName } from '../state/profileIcons'

type ProfileIconProps = {
  name?: string | null
  size?: number
  color?: string
  className?: string
  strokeWidth?: number
}

export function ProfileIcon({ name, size = 16, color, className, strokeWidth = 2 }: ProfileIconProps) {
  const Icon = (name && profileIcons[name]) || profileIcons[defaultProfileIconName]
  return <Icon size={size} color={color} className={className} strokeWidth={strokeWidth} />
}
